# Metric dictionary — v12

Tất cả `*_at_ms` dùng `performance.now()` main thread (ms, đơn điệu). `performance_time_origin_ms` trong metadata cho biết gốc. Worker Spark không cung cấp timestamp nội bộ; không ghép đồng hồ hay gọi Promise wall time là CPU time. CSV rỗng tương ứng JSON null, không phải 0. `field_status.json` đi cùng mỗi run.

## Danh tính và policy

Mọi dòng có run_id, scene_id, res, cycle_id, frame_id, tile_id khi áp dụng. Frame có occurrence_id `seek_epoch:ordinal`; loop lại cùng frame vẫn là occurrence mới. request_id riêng cho từng lượt gọi. Hai treatment complete-only, không viewport culling/ABR/progressive, không chuyển sang thời điểm mới trước khi đủ tile. `actually_skipped_frames=0` do hold, không phải mọi frame đúng deadline. Seek thay điểm phát là thao tác khác.

## HTTP

| Field | Mốc / đơn vị / giới hạn |
| --- | --- |
| queued_at_ms → fetch_start_at_ms | app_queue_ms, gồm chờ ngân sách raw và slot HTTP |
| fetch_start_at_ms → headers_at_ms | fetch() tới lúc trả Response; không gắn nhãn TTFB chính xác |
| requestStart → responseStart của ResourceTiming | ttfb_ms; null nếu RT không cho thấy hai mốc hợp lệ; không phải server processing time |
| headers_at_ms → body_end_at_ms | body_receive_wall_ms; gồm đọc stream phía ứng dụng |
| fetch_start_at_ms → body_end_at_ms | fetch_ms; wall time, không cộng các request song song thành thời gian của run |
| body_bytes | byte chunk ứng dụng thực nhận; có cả cache/unknown và byte nhận dở trước lỗi/hủy |
| transfer_size / encoded_body_size / decoded_body_size | ResourceTiming nếu có; transferSize không phải wire bytes chính xác |
| source, source_reason | network, http_cache, app_byte_cache, app_prepared_cache hoặc unknown; phân loại có chứng cứ, không đoán từ riêng transferSize=0 |
| url_load_index / reload_index / retry_index | lần gọi asset / lượt fetch HTTP trước đó của URL trong run / luôn 0 vì không tự retry |
| body_buckets | cặp [index 100 ms tương đối run_start, bytes chunk] để xuất đường thời gian |

RT cùng URL lấy entry hoàn tất có startTime phù hợp fetch. Thiếu TAO/entry, revalidation lẫn cache hoặc service worker → unknown. transferSize=0 và decodedBodySize=0 không chứng minh cache. deliveryType=cache hoặc transfer=0 với body RT dương là bằng chứng cache. Positive transfer + encoded body là mẫu network, trừ revalidation/SW. Các ràng buộc trình duyệt vẫn áp dụng.

`network_goodput_bps = sum(successful network-classified body_bytes) × 8000 / union([fetch_start,body_end])` (ms → s). Khoảng song song lấy hợp, không lấy tổng. Chỉ dùng request thành công có nguồn network xác nhận; cache không vào mẫu. Không có mẫu thì null. Số này là goodput trong thời gian fetch đang hoạt động, không phải cam kết băng thông link. Body tổng và network/cache/unknown được xuất riêng. Resource transfer sum chỉ có khi ít nhất một entry RT hợp lệ, kèm valid_n.

Live chart ghi rõ tốc độ **nhận body gồm cache/unknown**. `samples.csv` có cửa sổ goodput xấp xỉ từ bucket 100 ms ở cuối run; trường goodput_window_ms ghi mẫu số thực tế (thường 600 ms), không gọi đó là băng thông mạng tức thời chính xác. Chunk arrival bị ảnh hưởng buffering trình duyệt.

## Decode / RAM / tài nguyên

| Field | Phạm vi |
| --- | --- |
| bytes_ready_at_ms | đầy đủ byte một file; frame chỉ khi mọi file đã tải |
| app_decode_queue_ms | hàng đợi gate của ứng dụng, không phải queue Worker nội bộ Spark |
| constructor_cpu_ms | CPU wall quanh constructor synchronous trên main thread |
| parse_pack_wall_ms | constructor đến initialized, gồm Worker acquisition/copy/parse/pack và chờ; không phải thời gian CPU độc quyền |
| bounds_cpu_ms | quanh getBoundingBox trên main thread nếu bật; null khi tắt |
| parsed_ready_at_ms | file/mesh đã initialized; frame chỉ khi mọi tile initialized, chưa gọi GPU-ready |
| worker_internal_queue_ms / ply_parse_only_ms / pack_only_ms / worker_transfer_ms | null: stock Spark 2.3.1 không cung cấp public hook tách |
| upload_submit_at_ms / upload_submit_cpu_ms | initTexture của base source; SH và texture nội bộ còn có thể được tạo khi update/draw |
| spark_update_wall_ms | await Spark.update, bao gồm generation/readback/sort/wait. Không gọi là isolated sorting CPU/GPU |

Cả hai treatment dùng cùng đường code. Prepared cache hit có parse_pack_wall_ms=null với lý do; không ghi 0 ms decode như một mẫu network/parse mới. Worker pool nội bộ Spark tách khỏi app gate (đã xem workerPool.withWorker trong nguồn); không gắn app queue làm Worker queue.

## GPU / render / presentation

`render_submit_cpu_ms` đo quanh renderer.render(); GPU draw timer chỉ bao quanh draw submission của renderer, **không gồm Spark.update trước đó**. EXT_disjoint_timer_query_webgl2 đọc không chặn ở các lần poll sau, ns chia 1e6. Unsupported/disjoint/pending/disabled thì null với reason; query giới hạn 16 và luôn delete. Không gl.finish. Fence không đồng bộ được poll bằng clientWaitSync timeout=0; gpu_complete_observed_at_ms là cận trên lúc ứng dụng quan sát GPU hoàn thành sau draw, không phải scanout. Không thấy trước cleanup thì null.

`presented_estimate_at_ms`: ngay sau awaited update + render() return. Dùng làm mốc ước lượng ở mức ứng dụng, không chứng minh pixel đã hiển thị. `gpu_ready_at_ms` luôn null vì không suy diễn hoàn tất GPU từ initialized hay upload. Không lấy 1000/FPS thành GPU time. Không đo CPU%, GPU%, total VRAM hoặc motion-to-photon.

## Nội dung / thời gian

| Metric | Định nghĩa |
| --- | --- |
| time_to_first_visible_content_ms | run_start tới presented_estimate đầu tiên. Bằng first complete trong complete-only |
| time_to_first_complete_frame_ms | cùng mốc trên; không đếm tile đầu tiên như frame |
| startup_delay_ms | run_start tới lần draw submit ước lượng đầu sau khi đủ startupFrames đã parsed; bao gồm update đầu |
| content_fps | số occurrence frame hoàn chỉnh mới / active_playback_wall_ms × 1000 |
| active_playback_wall_ms | từ first present tới kết thúc, gồm buffering; loại user pause và seek; giữ thêm thời gian danh định của frame cuối trong nonloop |
| raf_hz / render_submit_fps | callback rAF / số draw thực sự gọi, chia wall run gồm startup. Sample cửa sổ dùng delta bộ đếm/thời gian thực |
| complete_frame_interval_ms | khoảng giữa hai presented_estimate liên tiếp cùng playback_epoch; không bắc qua pause/seek |
| enqueue_to_present_ms | enqueued_at → presented_estimate; không gọi là GPU latency |
| buffering_count / buffering_ms | sau startup, tới hạn thiếu frame → giữ frame cũ, đóng khi có frame mới; startup/pause/seek/end không tạo stall |
| stall_ratio | buffering_ms / active_playback_wall_ms, null nếu mẫu số 0 |
| buffer_ready_frames / seconds | số frame liên tiếp từ occurrence tiếp theo đã parsed; seconds = frames / target FPS. Không phải GPU-completed buffer |
| fixed_deadline_at_ms | anchor first present + ordinal × period + user pause duration; không lùi theo buffering; seek tạo epoch/anchor mới; first frame không có deadline |
| deadline_due_n / miss_n / ratio | occurrence có fixed deadline đã tới; miss nếu **parse/pack chưa xong** trước hạn. Đây là readiness ở RAM, không đo GPU-readiness |
| presented_after_deadline_n | presented_estimate muộn hơn fixed deadline, tách khỏi miss readiness; có thể parse đúng hạn mà update/draw muộn |
| actually_skipped_frames | 0 theo policy hold; frame đến muộn vẫn phát, không gọi là skipped |
| seek_latency_ms | seek command → first requested complete occurrence presented estimate; không tính vào rebuffering |

Playback clock giữ phase khi jitter nhỏ, rebase khi buffering/quá một chu kỳ, không đẩy hàng loạt frame catch-up trong một callback. Fixed deadline vẫn giữ lịch để không che việc xử lý thiếu throughput. Khi pause, các deadline pending được dời theo thời gian pause. Dừng run chốt thời gian trước cleanup; task không thể hủy trong Worker được đợi rồi dispose, không ghi đè scene/seek mới.

Tile: `first_tile_bytes_ready_at_ms`, `first_tile_parsed_at_ms` trên frame và rows tile cho biết tile đầu và đủ tập; frame status=parsed khi đủ tập, presented sau **một** swap cả frame. Tile updates/s chỉ là số tile thay thế, không phải content FPS. Không có viewport information nên không xuất số tile ngoài viewport giả định; không có progressive nên không giả lập tuổi tile cũ. Frame/tile/request lỗi/hủy và stale count được giữ.

## Bộ nhớ / thống kê / overhead

Raw unique ArrayBuffer: hợp các buffer ứng dụng đang đọc/đưa loader và byte cache, chống đếm trùng. Raw reservation = body + một input copy ước lượng do Spark slice; không quan sát chính xác lifetime copy nội bộ Worker. Parsed/source_arraybuffer_bytes: typed arrays packedArray/SH do mesh đang giữ (unique trong mesh), không gồm tổng heap. Reservation và source GPU estimate làm tròn theo texture row ×80 bytes/splat để chừa SH3; GPU source estimate chỉ mesh đã submit. Không bao gồm framebuffer, sort/generator, driver, toàn process/VRAM. `performance.memory.usedJSHeapSize` nếu trình duyệt cung cấp cũng không phải RAM toàn process. Count created/disposed và số frame/Gaussian hiện diện là counter ứng dụng, không phải GPU profiler.

Cache giới hạn bytes LRU, frame cache giới hạn reservation LRU, pin current + scheduling window, chỉ loại ready asset không pin. Frame/HTTP/prepare concurrency độc lập. Đổi budget giảm cache trước run mới. Log limit dừng run và đánh dấu invalid; tổng log giữ trong UI giới hạn trước khi chạy thêm. Xuất dữ liệu rồi xóa kết quả để tránh RAM log tăng.

Stats bỏ null/NaN, ghi valid_n; mean/median, p95 ≥20 mẫu, p99 ≥100. Percentile frame trong run là mô tả tương quan theo thời gian; so sánh độc lập dùng ≥5 run và group cấu hình. Recorder OFF chỉ giữ frame/sample, bỏ detailed rows, ghi lý do unavailable; dùng để đo overhead toàn phép đo trên máy thật. Microbenchmark đi kèm chỉ đo ghi log Node, không suy ra overhead của GPU timer/browser hay tốc độ thực nghiệm.
