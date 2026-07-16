"""
server.py — DentScan AI API bridge
====================================
This file is the ONLY thing that runs in production (Render). It is
completely separate from backend.ipynb — the notebook is never imported,
executed, or modified by this file.

Why not just run the notebook itself?
--------------------------------------
backend.ipynb trains the CNN from scratch every time it's run top-to-bottom
(it needs the dataset in ../data/raw/... and takes real time on a CPU/GPU).
That's perfect for experimenting locally, but useless as a web server:
Render doesn't have your dataset, and you don't want to retrain on every
request or every deploy.

So the split is:
  - backend.ipynb  -> where you train and re-save the model (untouched)
  - server.py       -> loads the ALREADY-TRAINED weights (car_damage_cnn.pt)
                        and serves predictions over HTTP

The CarDamageCNN class and predict_image() logic below are copied
byte-for-byte in behavior from the notebook's own cells (9 and 18), so the
predictions are identical to what the notebook would give you.

Run locally:
    python server.py
    # -> http://localhost:5050

Run in production (Render):
    gunicorn server:app --bind 0.0.0.0:$PORT
"""

import os
import io
import base64
from datetime import datetime

import torch
import torch.nn as nn
from torchvision import transforms
from PIL import Image

from flask import Flask, request, jsonify
from flask_cors import CORS


# ──────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────
# Path to the trained weights produced by backend.ipynb's "Save the trained
# model" cell. Override with the MODEL_PATH env var if you place the file
# somewhere else on the server.
MODEL_PATH = os.environ.get("MODEL_PATH", "car_damage_cnn.pt")

# Comma-separated list of origins allowed to call this API (your Netlify
# site). Defaults to "*" (open) so local dev / quick testing just works.
# In production, set ALLOWED_ORIGIN to something like:
#   https://dentscan.netlify.app
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


# ──────────────────────────────────────────────
# Model architecture
# (identical to the CarDamageCNN class defined in backend.ipynb, cell 9)
# ──────────────────────────────────────────────
class CarDamageCNN(nn.Module):
    def __init__(self):
        super().__init__()

        def conv_block(in_ch, out_ch):
            return nn.Sequential(
                nn.Conv2d(in_ch, out_ch, kernel_size=3, padding=1),
                nn.BatchNorm2d(out_ch),
                nn.ReLU(inplace=True),
                nn.MaxPool2d(2),
            )

        self.features = nn.Sequential(
            conv_block(3, 32),
            conv_block(32, 64),
            conv_block(64, 128),
            conv_block(128, 256),
        )

        self.global_pool = nn.AdaptiveAvgPool2d(1)

        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Dropout(0.4),
            nn.Linear(256, 64),
            nn.ReLU(inplace=True),
            nn.Dropout(0.3),
            nn.Linear(64, 1),
        )

    def forward(self, x):
        x = self.features(x)
        x = self.global_pool(x)
        x = self.classifier(x)
        return x


# ──────────────────────────────────────────────
# Load the trained checkpoint saved by the notebook
# (torch.save({"model_state_dict":..., "class_to_idx":..., "image_size":...}, MODEL_PATH))
# ──────────────────────────────────────────────
if not os.path.exists(MODEL_PATH):
    raise FileNotFoundError(
        f"Could not find '{MODEL_PATH}'. Make sure car_damage_cnn.pt "
        f"(produced by running backend.ipynb) sits next to server.py, "
        f"or set the MODEL_PATH environment variable to its location."
    )

checkpoint = torch.load(MODEL_PATH, map_location=DEVICE, weights_only=False)

CLASS_TO_IDX = checkpoint["class_to_idx"]
DAMAGE_IDX = CLASS_TO_IDX["damage"]
IMAGE_SIZE = checkpoint.get("image_size", 128)

model = CarDamageCNN().to(DEVICE)
model.load_state_dict(checkpoint["model_state_dict"])
model.eval()

print(f"✅ Loaded model from {MODEL_PATH} (device={DEVICE}, class_to_idx={CLASS_TO_IDX})")


# ──────────────────────────────────────────────
# Inference
# (identical logic to predict_image() in backend.ipynb, cell 18)
# ──────────────────────────────────────────────
inference_transform = transforms.Compose([
    transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])


def predict_image(image_bytes):
    """Takes raw image bytes -> returns dict with damaged (bool), confidence (float), label (str)."""
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    tensor = inference_transform(image).unsqueeze(0).to(DEVICE)

    with torch.no_grad():
        logit = model(tensor)
        prob_damage = torch.sigmoid(logit).item()

    if DAMAGE_IDX == 1:
        p_damaged = prob_damage
    else:
        p_damaged = 1 - prob_damage

    is_damaged = p_damaged > 0.5
    confidence = p_damaged if is_damaged else (1 - p_damaged)

    return {
        "damaged": bool(is_damaged),
        "confidence": round(float(confidence), 4),
        "label": "Dent or scratch detected" if is_damaged else "No visible damage detected",
    }


# ──────────────────────────────────────────────
# Flask API
# (routes mirror backend.ipynb, cell 21 — minus /report, which the frontend
#  now generates client-side with jsPDF via report-generator.js)
# ──────────────────────────────────────────────
app = Flask(__name__)
CORS(app, origins=ALLOWED_ORIGIN if ALLOWED_ORIGIN == "*" else ALLOWED_ORIGIN.split(","))


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "model_loaded": True,
        "device": str(DEVICE),
        "timestamp": datetime.utcnow().isoformat(),
    })


@app.route("/predict", methods=["POST"])
def predict():
    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    file = request.files["image"]
    image_bytes = file.read()

    try:
        result = predict_image(image_bytes)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    app.run(host="0.0.0.0", port=port, debug=False)
