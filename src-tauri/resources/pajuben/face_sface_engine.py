#!/usr/bin/env python3
"""YuNet 检脸 + SFace 五点对齐与专用人脸嵌入。JSON 输出与旧助手兼容。"""

import base64
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "face_runtime", "vendor39"))

import cv2
import numpy as np

MODEL_DIR = os.path.join(HERE, "face_runtime", "models")
DETECT_MODEL = os.path.join(MODEL_DIR, "face_detection_yunet_2023mar.onnx")
RECOGNIZE_MODEL = os.path.join(MODEL_DIR, "face_recognition_sface_2021dec.onnx")


def save_crop(image, face, path):
    x, y, w, h = face[:4]
    px, py = w * 0.28, h * 0.35
    x1, y1 = max(0, int(x - px)), max(0, int(y - py))
    x2 = min(image.shape[1], int(x + w + px))
    y2 = min(image.shape[0], int(y + h + py))
    crop = image[y1:y2, x1:x2]
    return bool(crop.size and cv2.imwrite(path, crop, [cv2.IMWRITE_JPEG_QUALITY, 90]))


def main():
    if len(sys.argv) < 4 or sys.argv[1] != "scan":
        print("usage: face_sface_engine.py scan OUT_DIR IMAGE...", file=sys.stderr)
        return 2
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    detector = cv2.FaceDetectorYN.create(DETECT_MODEL, "", (320, 320), 0.82, 0.3, 5000)
    recognizer = cv2.FaceRecognizerSF.create(RECOGNIZE_MODEL, "")
    output = []
    for image_index, source in enumerate(sys.argv[3:]):
        image = cv2.imread(source)
        if image is None:
            continue
        detector.setInputSize((image.shape[1], image.shape[0]))
        _, faces = detector.detect(image)
        if faces is None:
            continue
        for face_index, face in enumerate(faces):
            try:
                aligned = recognizer.alignCrop(image, face)
                feature = recognizer.feature(aligned).reshape(-1).astype("float32")
                norm = float(np.linalg.norm(feature))
                if norm <= 0:
                    continue
                feature /= norm
                crop_path = os.path.join(out_dir, f"face_{image_index:05d}_{face_index:02d}.jpg")
                if not save_crop(image, face, crop_path):
                    continue
                output.append({
                    "source": source,
                    "crop": crop_path,
                    "quality": float(min(face[2], face[3]) * face[14]),
                    "feature": base64.b64encode(feature.tobytes()).decode(),
                    "count": int(feature.size),
                    "engine": "opencv-sface-v1",
                })
            except cv2.error:
                continue
    json.dump(output, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
