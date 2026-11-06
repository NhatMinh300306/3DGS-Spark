# Validation thực tế — v12, 2026-11-05

Đây là kiểm tra gói local. Website v11 được lưu từ trước không được cập nhật bởi thao tác đóng ZIP này.

## Đã chạy

- Node: **21/21 tests**. Clock giữ phase, buffer/hold, pause/seek, deadline, quantile thresholds, queue cancellation, LRU/trim, HTTP/cache/unknown, lỗi/truncation/abort, GPUtimer bất đồng bộ/disjoint bằng WebGLmock; scheduler thực full/tile với adapter mock, missingtile, seek và stale disposal.
- Python: **8/8 tests**. Đọc/viết PLYSH3, phát hiện trùng/thiếu/sửa thuộc tính, dữ liệu truncate/nonfinite, dò hai thứ tự thư mục, nhập full rồi tile, splitter giữ đúng mỗiGaussian, server Range206/MIME/CORS/TAO, quality identicalimages/cameramismatch.
- Fixture: **120 cặp** exact scalar multiset verified (4res×30frame), SH3 và normal fields giữ nguyên. Full có1file/frame, Tile có3file/frame. Full sourcebytes1,968,840; Tile sourcebytes2,335,230, gồm headerlặp. Đây là fixture rất nhỏ, không phải dữ liệu8i thực nghiệm; không suy%hiệu năng từ đó.
- Trình duyệt: app/catalog/manifest tải được, báo rõ môi trường không tạo được WebGLcontext và vô hiệu hóa start. Không để màn hình ngầm báo đãrender.
- Trình duyệt Worker thực Spark2.3.1 (`/bench/qa-loader.html`): decodedres8frame1450 Full=24Gaussian, baTile tổng=24Gaussian; cảhai cósh1/sh2/sh3. Đây là giải mãCPUWorker, **không** kiểm tra drawGPU.
- Syntax/format: JS kiểm traNode và formatPrettier; Pythoncompile. ZIPCRC, fileentry và smokeCLI saugiảinén được kiểmtra khiđónggói.
- Recorder microbenchmark: `benchmark-validation/instrumentation-overhead.json` có5lầnONvà5lầnOFF, 10,000events/lần trongNode; **không** phải overheadGPUtimer hoặc benchmarkFPS củaweb.

## Chưa kiểm chứng

Môi trường browser trả `GL_VENDOR = Disabled, GL_RENDERER = Disabled`; không tạo đượcWebGL2context. Vìvậy chưa đoSparkupdate/drawGPU, chưa xemảnhGaussianthực, chưa capturePNG rendererhay chạy30contentFPS trênmáythật. GPUqueryunit testdùngmock, không đượcgọi là sốđoGPU.

Không có thư mụcPLYredandblackthật trongmôitrường. ĐườngdẫnmáyLinux/Windowscủabạn chỉlà thamchiếu; gói khôngchứadatasetriêng. Chưa đoA/Bthroughput/latency/FPS trên4res×30frame thật, chưatestmạngchậmthật, chưaxácminhđượccấu trúctilethựcngoàiJSONđãgửi. Khi chạyconfigure với datasetthật, scriptkiểmtra từngfile và từchối manifestmâu thuẫn.

Không công bốspeedup, đạt30FPS hay%tiếtkiệmbăngthông. Các sốtestfixture vàloadercompatibilitykhông thaythế validationGPU/datasetthật. Xemprotocolđểkiểmtra cold/warm/replay/seek/reschange/missingfile/mạngchậm trênmáycủabạn.
