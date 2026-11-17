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

MIT-Lizenztext (für beide): Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The
above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT
OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

`test/fixtures/plate-scene.jpg` – selbst erzeugtes Testbild (gezeichnetes Auto, erfundenes Kennzeichen).
