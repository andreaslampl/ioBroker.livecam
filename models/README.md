# Modelle

`yolox_nano.onnx` – YOLOX-Nano (COCO, 80 Klassen), aus dem Release 0.1.1rc0 von
https://github.com/Megvii-BaseDetection/YOLOX (Copyright (c) 2021-2022 Megvii Inc.), Lizenz Apache-2.0
(https://www.apache.org/licenses/LICENSE-2.0). Unverändert übernommen.
SHA-256: c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d

`plate_detect_384.onnx` – Kennzeichen finden: `yolo-v9-t-384-license-plates-end2end.onnx` aus
https://github.com/ankandrew/open-image-models (Release „assets“), Copyright (c) 2024 ankandrew, Lizenz MIT.
Unverändert übernommen (nur umbenannt).
SHA-256: 888397b96d761c89db40bc9c305838e8652660f5e282c2cadebbe8d2951a77a8

`plate_ocr_cct_s_v2.onnx` – Kennzeichen lesen: `cct_s_v2_global.onnx` von fast-plate-ocr
(https://github.com/ankandrew/fast-plate-ocr, Download über https://github.com/ankandrew/cnn-ocr-lp/releases,
Release „arg-plates“), Copyright (c) 2024 ankandrew, Lizenz MIT. Zeichen `0-9 A-Z`, 10 Stellen, Eingabe 128 × 64 RGB.
Unverändert übernommen (nur umbenannt).
SHA-256: 384bbbd2cea3ef54761d3df70822ef3a349ee1a112aeafddbe0e3ba06bc6e47b

`face_detect_yunet.onnx` – Gesichter finden: YuNet `face_detection_yunet_2023mar.onnx` aus https://github.com/opencv/opencv_zoo
(models/face_detection_yunet), Copyright (c) 2020 Shiqi Yu, Lizenz MIT. Unverändert übernommen (nur umbenannt).
SHA-256: 8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4

`face_recog_sface.onnx` – Gesichter vergleichen: SFace `face_recognition_sface_2021dec.onnx` aus https://github.com/opencv/opencv_zoo
(models/face_recognition_sface, Beitrag von Yaoyao Zhong, ONNX von Chengrui Wang), Lizenz Apache-2.0
(https://www.apache.org/licenses/LICENSE-2.0). Unverändert übernommen (nur umbenannt).
SHA-256: 0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79

`face_live_v2.onnx`, `face_live_v1se.onnx` – Lebenderkennung: MiniFASNetV2 / MiniFASNetV1SE (80 × 80) aus
https://github.com/minivision-ai/Silent-Face-Anti-Spoofing (`resources/anti_spoof_models/2.7_80x80_MiniFASNetV2.pth`,
`4_0_0_80x80_MiniFASNetV1SE.pth`), Copyright Minivision, Lizenz Apache-2.0. **Geändert:** mit `tools/convert-minifasnet.py`
von PyTorch nach ONNX umgewandelt (dieselben Gewichte, dasselbe Netz).
SHA-256: c65bcbc2e1877ddf5f4d5118ec9a9b44c1bfe8c7da7ed4dfa1a349a94f1f569f (v2),
3b7a2831c1c629b881a3a757d2d2fb4e94c5ea95974621e7eff28d2c8ef6af5b (v1se)

MIT-Lizenztext (Kennzeichen-Modelle und YuNet): Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The
above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT
OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

`test/fixtures/plate-scene.jpg` – selbst erzeugtes Testbild (gezeichnetes Auto, erfundenes Kennzeichen).
