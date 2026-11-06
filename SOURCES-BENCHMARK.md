# Nguồn sơ cấp và ánh xạ metric

Đã đọc phần evaluation; bảng phân biệt metric của bài với chẩn đoán do benchmark thêm. Không tuyên bố tái hiện hệ thống/codec/scheduler/QoE của các bài.

| Nguồn / phạm vi | Evaluation của bài | Ánh xạ triển khai | Giới hạn |
| --- | --- | --- | --- |
| [LTS: A DASH Streaming System for Dynamic Multi-Layer 3D Gaussian Splatting Scenes](https://people.cs.nycu.edu.tw/~chuang/pubs/pdf/2025mmsys.pdf), dynamic; §5.2 Metrics (PDFp8), §5.3 | PSNR, SSIM; missing frames không đáp ứng designated deadline; cumulative freeze time; representation bitrate | PSNR/SSIM offline; fixed deadlines với readiness RAM và presentation lateness tách; bufferingms; bytebody/run | Không tái hiện multi-layer additive/DASHcodec. res1/2/4/8 thay thế; readiness RAM không chứng minh GPU-complete. Bodybytes thực nhận không phải representation bitrate nguyên nghĩa bài |
| [SGSS: Streaming 6-DoF Navigation of Gaussian Splat Scenes](https://yaoliu-yl.github.io/publications/mmsys25-sgss.pdf), cảnh **tĩnh**, camera6DoF; §5.1 (PDFp7) | PSNR/SSIM/VMAF; downloadedMB; orbital/dolly traces; thí nghiệm networkrates100/150/200Mbps, RTT20ms | Camera trace tái lập; bodybytes/network-cache split; PSNR/SSIM offline | Không biến kết quả tĩnh thành dynamic30fps; baseline tải đủ tile nên không tuyên bố viewport bandwidthsavings. Không tái hiện VMAF hay đúng traces/dataset bài |
| [Adaptive 3D Gaussian Splatting Video Streaming](https://arxiv.org/html/2507.14432v1), dynamic; §IV-D, §V | QoE có quality, totalstall vàstallfrequency; PSNR/SSIM/LPIPS; transmissioncost; renderingFPS/decodinglatency discussion | Bufferingms/count/ratio; qualityoffline; bytes; contentFPS tách renderSubmit/rAF; combinedparsepackwall | Không tái hiện codec/geometricmotion/optimization, compressionratio hay QoEweights. Combinedwall không đồng nhất decodeCPU riêng của bài |

HTTP queue, ResourceTiming source classification, Worker observability/null, boundsCPU, asyncGPUtimer/fence, submitCPU, memoryestimate/LRU, created/disposed/stale và seeklatency là **chẩn đoán bổ sung của ứng dụng**, không gán thành những metric mà cả ba bài đều đo.

## Thư viện và đặc tả

- [Spark docs](https://sparkjs.dev/docs/) có thể nói phiên bản mới hơn. Gói chốt **Spark 2.3.1**; kiểm tra mã tag [v2.3.1](https://github.com/sparkjsdev/spark/tree/v2.3.1), commit `2e9c2e74a486b1ba3a31025a22b231b8e4fccde3`. Đã đối chiếu SplatMesh.initialized/dispose, SplatLoader Worker copy/pool, PackedSplats.getTexture, SparkRenderer.update/clearSplats. App không patch Worker nội bộ hoặc dùng hook không có thực.
- [Three.js r180](https://github.com/mrdoob/three.js/tree/r180), npm0.180.0: WebGLRenderer, initTexture/render, OrbitControls. Không coi initTexture là GPU hoàn tất.
- [Resource Timing](https://www.w3.org/TR/resource-timing/): transfer/encoded/decodedBodySize, timingvisibility/TAO, requestStart/responseStart. Không suy source từ riêng transferSize0; không gọi transferSize là wirebytes chính xác.
- [EXT_disjoint_timer_query_webgl2](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/): asyncquery availability/disjoint/nsresult. Không chặngl.finish, nullkhiunsupported/disjoint.
- [fflate0.8.2](https://github.com/101arrowz/fflate/tree/v0.8.2): exportZIP sau run; giấy phép lưu cùngvendor.

Pipeline giữ Spark là rendererGaussian. App tải bằngfetch riêng để đo rồi truyềnfileBytes, không dùng fetchẩntrongSplatMesh. LODtắt. Đã verifyloaderPLY+SH3 bằngWorkertrìnhduyệt trênfixture; không có GPUWebGLtrongmôitrườngQA nên chưa verifydraw/visualqualitythật.
