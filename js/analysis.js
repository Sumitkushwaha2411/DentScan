/* ============================================
   AUTOSCAN AI — analysis.js
   Upload / Live Camera → POST to Flask backend → render result + history + report
   ============================================ */

(function () {
  'use strict';

  /* Point this at your Flask backend (runs from backend.ipynb) */
  const API_BASE = 'https://dentscan.onrender.com';

  let currentBlob = null;       // the image blob currently staged for analysis
  let currentMode = 'upload';   // 'upload' | 'camera'
  let cameraStream = null;
  let liveScanInterval = null;
  let lastResult = null;        // last prediction result (for report download)

  let scanCount = 0, damagedCount = 0, normalCount = 0;
  const history = [];

  /* ── DOM ── */
  const sideBtns        = document.querySelectorAll('.side-btn[data-mode]');
  const modeBtns         = document.querySelectorAll('.mode-btn[data-mode]');
  const uploadPanel        = document.getElementById('uploadPanel');
  const cameraPanel         = document.getElementById('cameraPanel');
  const uploadZone            = document.getElementById('uploadZone');
  const fileInput               = document.getElementById('fileInput');
  const uploadPreviewFrame        = document.getElementById('uploadPreviewFrame');
  const uploadPreviewImg            = document.getElementById('uploadPreviewImg');
  const analyzeUploadBtn              = document.getElementById('analyzeUploadBtn');
  const clearUploadBtn                  = document.getElementById('clearUploadBtn');

  const cameraFrame        = document.getElementById('cameraFrame');
  const cameraPlaceholder    = document.getElementById('cameraPlaceholder');
  const cameraVideo            = document.getElementById('cameraVideo');
  const captureCanvas            = document.getElementById('captureCanvas');
  const enableCameraBtn            = document.getElementById('enableCameraBtn');
  const captureBtn                   = document.getElementById('captureBtn');
  const liveScanToggle                 = document.getElementById('liveScanToggle');

  const resultPanel      = document.getElementById('resultPanel');
  const historyList         = document.getElementById('historyList');
  const toast                  = document.getElementById('toast');
  const backendStatus            = document.getElementById('backendStatus');

  const statScans     = document.getElementById('statScans');
  const statDamaged     = document.getElementById('statDamaged');
  const statNormal        = document.getElementById('statNormal');

  /* ── TOAST ── */
  function showToast(msg, type) {
    toast.textContent = msg;
    toast.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  /* ── BACKEND HEALTH CHECK ── */
  async function checkBackend() {
    try {
      const res = await fetch(`${API_BASE}/health`, { method: 'GET' });
      if (res.ok) {
        backendStatus.textContent = '✅ Connected to localhost:5050';
      } else {
        throw new Error('bad status');
      }
    } catch (err) {
      backendStatus.textContent = '⚠️ Backend not reachable. Run backend.ipynb first.';
    }
  }
  checkBackend();

  /* ── MODE SWITCHING ── */
  function setMode(mode) {
    currentMode = mode;
    sideBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    uploadPanel.style.display = mode === 'upload' ? 'block' : 'none';
    cameraPanel.style.display = mode === 'camera' ? 'block' : 'none';

    // stop camera + live scan if leaving camera mode
    if (mode !== 'camera') {
      stopLiveScan();
      stopCamera();
    }
    resultPanel.innerHTML = '';
  }
  [...sideBtns, ...modeBtns].forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  /* ══════════════════════════
     UPLOAD MODE
  ══════════════════════════ */
  uploadZone.addEventListener('click', () => fileInput.click());
  uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) handleFileSelected(e.target.files[0]);
  });

  function handleFileSelected(file) {
    if (!file.type.startsWith('image/')) {
      showToast('Please select an image file.', 'error');
      return;
    }
    currentBlob = file;
    const url = URL.createObjectURL(file);
    uploadPreviewImg.src = url;
    uploadPreviewFrame.style.display = 'block';
    uploadZone.style.display = 'none';
    analyzeUploadBtn.disabled = false;
    clearUploadBtn.style.display = 'inline-flex';
    resultPanel.innerHTML = '';
  }

  clearUploadBtn.addEventListener('click', () => {
    currentBlob = null;
    fileInput.value = '';
    uploadPreviewFrame.style.display = 'none';
    uploadZone.style.display = 'block';
    analyzeUploadBtn.disabled = true;
    clearUploadBtn.style.display = 'none';
    resultPanel.innerHTML = '';
  });

  analyzeUploadBtn.addEventListener('click', () => {
    if (currentBlob) analyzeImage(currentBlob, uploadPreviewImg.src);
  });

  /* ══════════════════════════
     CAMERA MODE
  ══════════════════════════ */
  enableCameraBtn.addEventListener('click', startCamera);

  async function startCamera() {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      cameraVideo.srcObject = cameraStream;
      cameraVideo.style.display = 'block';
      cameraPlaceholder.style.display = 'none';
      enableCameraBtn.style.display = 'none';
      captureBtn.style.display = 'inline-flex';
    } catch (err) {
      console.error('Camera error:', err);
      showToast('Could not access camera. Check permissions, and make sure this page is served over http://localhost (not file://).', 'error');
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    cameraVideo.style.display = 'none';
    cameraPlaceholder.style.display = 'block';
    enableCameraBtn.style.display = 'inline-flex';
    captureBtn.style.display = 'none';
    liveScanToggle.checked = false;
  }

  function captureFrame() {
    const w = cameraVideo.videoWidth, h = cameraVideo.videoHeight;
    if (!w || !h) return null;
    captureCanvas.width = w;
    captureCanvas.height = h;
    const ctx = captureCanvas.getContext('2d');
    ctx.drawImage(cameraVideo, 0, 0, w, h);
    return new Promise(resolve => {
      captureCanvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.9);
    });
  }

  captureBtn.addEventListener('click', async () => {
    const blob = await captureFrame();
    if (blob) {
      const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.9);
      analyzeImage(blob, dataUrl);
    }
  });

  liveScanToggle.addEventListener('change', () => {
    if (liveScanToggle.checked) startLiveScan();
    else stopLiveScan();
  });

  function startLiveScan() {
    if (!cameraStream) { showToast('Enable the camera first.', 'error'); liveScanToggle.checked = false; return; }
    liveScanInterval = setInterval(async () => {
      const blob = await captureFrame();
      if (blob) {
        const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.9);
        analyzeImage(blob, dataUrl, true);
      }
    }, 2000);
  }

  function stopLiveScan() {
    if (liveScanInterval) { clearInterval(liveScanInterval); liveScanInterval = null; }
  }

  /* ══════════════════════════
     ANALYZE — shared pipeline for both modes
  ══════════════════════════ */
  async function analyzeImage(blob, previewSrc, silent) {
    if (!silent) {
      resultPanel.innerHTML = `
        <div class="result-panel">
          <div class="result-body" style="align-items:center;flex-direction:row;gap:10px;justify-content:center;padding:28px">
            <span class="spinner dark"></span> Analyzing image…
          </div>
        </div>`;
    }

    const formData = new FormData();
    formData.append('image', blob, 'capture.jpg');

    try {
      const res = await fetch(`${API_BASE}/predict`, { method: 'POST', body: formData });
      if (!res.ok) throw new Error('Prediction request failed');
      const data = await res.json();

      lastResult = { ...data, image: previewSrc, timestamp: new Date() };
      renderResult(lastResult);
      addToHistory(lastResult);
      updateStats(lastResult);
      backendStatus.textContent = '✅ Connected to localhost:5050';

    } catch (err) {
      console.error('Predict error:', err);
      backendStatus.textContent = '⚠️ Backend not reachable. Run backend.ipynb first.';
      resultPanel.innerHTML = `
        <div class="result-panel">
          <div class="result-header dmg">
            <span class="result-badge">⚠️</span>
            <div>
              <div class="result-verdict">Could not reach backend</div>
              <div class="result-sub">Make sure backend.ipynb is running (Run All) on localhost:5050</div>
            </div>
          </div>
        </div>`;
      showToast('Backend not reachable — is the notebook running?', 'error');
    }
  }

  function renderResult(result) {
    const isDamaged = !!result.damaged;
    const pct = Math.round((result.confidence || 0) * 100);

    resultPanel.innerHTML = `
      <div class="result-panel">
        <div class="result-header ${isDamaged ? 'dmg' : 'ok'}">
          <span class="result-badge">${isDamaged ? '❌' : '✅'}</span>
          <div>
            <div class="result-verdict">${isDamaged ? 'Damaged' : 'Normal'}</div>
            <div class="result-sub">${result.label || (isDamaged ? 'Dent or scratch detected' : 'No damage detected')}</div>
          </div>
        </div>
        <div class="result-body">
          <div class="confidence-row">
            <span class="confidence-label">Confidence</span>
            <div class="confidence-track">
              <div class="confidence-fill ${isDamaged ? 'dmg' : 'ok'}" style="width:${pct}%"></div>
            </div>
            <span class="confidence-pct">${pct}%</span>
          </div>
          <div class="result-actions">
            <button class="btn-outline" id="downloadReportBtn">⬇ Download Report</button>
          </div>
        </div>
      </div>`;

    document.getElementById('downloadReportBtn')?.addEventListener('click', downloadReport);
  }

  function addToHistory(result) {
    history.unshift(result);
    if (history.length > 20) history.pop();

    historyList.innerHTML = history.map(r => `
      <div class="history-row">
        <img class="history-thumb" src="${r.image}" alt="">
        <span>${r.damaged ? 'Dent / scratch detected' : 'No damage detected'}</span>
        <span class="${r.damaged ? 'tag-dmg' : 'tag-ok'}">${r.damaged ? 'Damaged' : 'Normal'}</span>
        <span class="history-time">${r.timestamp.toLocaleTimeString()}</span>
      </div>
    `).join('');
  }

  function updateStats(result) {
    scanCount++;
    if (result.damaged) damagedCount++; else normalCount++;
    statScans.textContent = scanCount;
    statDamaged.textContent = damagedCount;
    statNormal.textContent = normalCount;
  }

  /* ══════════════════════════
     REPORT DOWNLOAD (generated client-side — no backend call)
  ══════════════════════════ */
  function downloadReport() {
    if (!lastResult) return;

    if (!window.DentScanReport) {
      showToast('Report generator not loaded.', 'error');
      console.error('report-generator.js (window.DentScanReport) is missing. Check the <script> tags in analysis.html.');
      return;
    }

    try {
      window.DentScanReport.generateReportPDF({
        damaged: lastResult.damaged,
        confidence: lastResult.confidence,
        label: lastResult.label,
        image: lastResult.image,          // base64 data URL
        timestamp: lastResult.timestamp   // Date object — generator handles conversion
      });
      showToast('Report downloaded.', 'success');
    } catch (err) {
      console.error('Report generation error:', err);
      showToast('Could not generate report.', 'error');
    }
  }

})();