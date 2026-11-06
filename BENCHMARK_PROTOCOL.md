# Protocol tái lập — Full PLY / Tile PLY

## Câu hỏi và dữ liệu

Câu hỏi: với cùng Gaussian và renderer/camera/canvas/target FPS, chia file có thay đổi thời gian chuẩn bị và đổi frame hoàn chỉnh ra sao? Complete-only tải đủ tile; không có tiết kiệm viewport trong baseline. Bốn res là bốn điều kiện riêng, không xếp hạng bằng PSNR ở kích thước ảnh khác nhau.

Đối chiếu scalar multiset phải qua cả 120 cặp. Không tự loại SH, opacity thấp, thay codec, gộp các res hay sửa dữ liệu để một treatment nhanh hơn. Không dùng CAGS/Draco/RAD ở phép so sánh này. Nếu tile cũ chứa Gaussian trùng ranh giới, tạo baseline mới bằng splitter hoặc ghi rõ dữ liệu không tương đương, không báo speedup công bằng.

## Điều kiện phải lưu

- Browser/version, GPU/driver bằng công cụ máy thật nếu cần; hệ điều hành, nguồn điện, hardware acceleration, canvas/pixel ratio. Chỉ metadata WebGL công khai được web đọc, không lấy làm phép đo GPU%.
- Dataset/hash, res, 30 frame, target30, startup/prefetch, concurrency, ngân sách, loop, camera trace/hash và fixed camera.
- Mạng: local/LAN/WAN, công cụ giới hạn mạng và latency, server static/cache, trạng thái proxy. UI network_note là ghi chú, không tự cấu hình mạng.
- Hai treatment cùng cấu hình; cả hai đã verify. Để loop=false cho 5 cặp. Không thao tác camera/seek/pause trong baseline.

30 frame ở30fps có thời lượng danh định1giây; thí nghiệm ngắn nhạy với startup và jitter. Báo riêng first-frame/startup và active playback. Nếu loop để khảo sát warm state, ghi vòng/cycle_id, không trộn vòng đầu vào warm average. Muốn nhiều mẫu độc lập chạy nhiều run, không coi các loop cùng cache là independent cold runs.

## Cache cases

| Case | Cách làm | Kết luận được |
| --- | --- | --- |
| Bypass | no-store, xóa app cache giữa run; DevTools Disable cache nếu muốn | Fetch yêu cầu no-store; không chứng minh DNS/OS/server cold |
| HTTP cold | browser profile/DevTools clear cache trước từng run A và B, không SW; giữ tab visible | HTTP cold theo quy trình đã làm; RT xác minh nguồn |
| HTTP warm | tải từng treatment đủ một lần trước run đo, cache default | phân tích hit/miss/unknown riêng; warm full và warm tile phải tương ứng |
| App bytes | prime cùng điều kiện, rồi app-bytes | Byte cache bounded, có thể không đủ toàn bộ30 frame |
| App prepared | prime cả hai treatment rồi app-processed | Mesh initialized reuse; cache chung bounded có thể evict khác nhau theo chi phí source texture |

Không gộp kết quả của các cache case. Nút xóa cache ứng dụng không xóa HTTP cache; UI ghi điều này. 5 cặp tự động không tự đảm bảo cold HTTP. Không dùng cache hit để ước lượng network throughput.

## Chạy

1. Kiểm tra nhập dataset, camera và dữ liệu đối chiếu. Chạy chức năng trước: start/end/replay, seek0→29→10, đổi res/scene **giữa** run, orbit manual, thiếu file trong bản sao dataset để kiểm tra lỗi.
2. Cố định conditions. Với mạng chậm dùng DevTools Network throttling; ghi bandwidth/latency. Ubuntu có thể dùng tc/netem nếu đã quen, nhưng web không tự thay network settings. Không mô phỏng bằng delayJS rồi gọi đó là mạng thật.
3. Chạy 5 cặp AB/BA cho mỗi res/cache/network. Mỗi run ID riêng, có đầy đủ summary, không chỉ 1Hz samples. Giữ cửa sổ active; tab hidden làm invalid_visibility.
4. Xuất ZIP sau batch; giữ raw logs. Thử instrumentationOFF cùng conditions để đánh giá overhead trên máy thật, không so ON-vsOFF khácdataset/camera.
5. Dùng summarize_benchmarks.py, kiểm tra ≥5 completed run/treatment và matchinggroup. Run error/stopped/log_limit/invalid_visibility báo riêng, không âm thầm bỏ để cải thiện mean.
6. Báo mean/median per-run metric, valid_n; p95/p99 chỉ khi đủ n. Ghi contentFPS cạnh renderSubmit/rAF và time-to-first/buffering/deadlinemiss. Không lấy tileupdates/s thànhcontentFPS. Không gọi bitrate biểu diễn thành measuredlinkbandwidth.

## Chẩn đoán

- App queue dài: raw/slot budget hoặc concurrency giới hạn; không đồng nghĩa nội bộ Worker bận.
- parse_pack_wall dài: combined loader wall; cần thay Spark có hook nếu muốn tách copy/parse/pack; không suy ra riêng CPU time.
- update_wall dài: Spark generation/readback/sort/wait gộp. Nhiều tile có thể tăng số object, padding, HTTP request và scheduling overhead dù cùng Gaussian.
- render_submitCPU thấp không chứng minh GPU rảnh; GPU timer chỉ draw scope và có thể null. Đối chiếu profiler chính thức của browser/OS trên máy thật nếu cần.
- Sau vòng đầu nhanh hơn: phân biệt HTTP cache, app bytes, prepared cache qua source và parse rows; không tự quy hết cho decode.

## Chất lượng ảnh

Capture tách speedrun, fixedcamera/canvas/background/color. Cùng frame/res, chạy offline PSNR/SSIM và tùy chọnLPIPS. Full PLY là equivalence reference, không phải GT camera của dataset. Không báo chất lượng scene thực nếu chỉ có fixture. Không lấy chất lượng khác nhau để kết luận tile transport nhanh hơn công bằng.

## Báo cáo

Kèm metadata và versionZIP, rawlogs, configurationgroups, số run lỗi, n, nullreasons, networksource evidence. Với dataset thật chưa chạy phải ghi chưa đo. Không khẳng định30fps, tiết kiệm% hay nguyên nhânCPU/GPU chỉ từ tên cộtCSV hoặc screenshothtop.
