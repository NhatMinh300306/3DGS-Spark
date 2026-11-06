# Splat Lab — Full PLY / Tile PLY Benchmark v12

Mã nguồn độc lập cho phép so sánh hai cách truyền cùng chuỗi Gaussian: **mỗi frame một PLY** và **mỗi frame nhiều tile PLY**. Cả hai dùng Spark **2.3.1**, Three.js **0.180.0**, cùng camera/canvas/renderer. Không tích hợp CAGS hoặc Draco trong gói benchmark này. Đây là gói chạy local; không tự thay đổi website v11 đang được lưu trước đó.

Gói có sẵn fixture **Orbit SH3 — SYNTHETIC**, 30 frame 1450–1479 × bốn res, 3 tile không rỗng/frame. Đây không phải dữ liệu 8i. Không dùng tốc độ của fixture để kết luận về redandblack.

## 1. Mở thử ngay

Giải nén ZIP ra thư mục thường. Mở terminal **tại thư mục có `serve_benchmark.py`**.

**Windows 11 — CMD:**

```bat
py serve_benchmark.py --bind 127.0.0.1 --port 8765 --directory dist
```

**Windows 11 — PowerShell:**

```powershell
py .\serve_benchmark.py --bind 127.0.0.1 --port 8765 --directory dist
```

**Ubuntu — Bash:**

```bash
python3 serve_benchmark.py --bind 127.0.0.1 --port 8765 --directory dist
```

Mở <http://127.0.0.1:8765/bench/>. Bấm **Bắt đầu run**. Cần trình duyệt hỗ trợ WebGL2; không mở bằng `file://`. Spark/Three/fflate được lưu sẵn trong `dist/bench/vendor`, không cần npm hoặc Internet để mở. Ctrl+C dừng server. Nếu Windows báo WinError 10013, thử port 8766; không cần Administrator.

## 2. Chuẩn bị môi trường nhập dữ liệu

Server không cần package Python ngoài thư viện chuẩn. Công cụ đọc/kiểm tra/chia PLY cần NumPy. Không cần activate môi trường ảo, vì lệnh dưới dùng trực tiếp Python trong môi trường đó.

**CMD:**

```bat
py -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-benchmark.txt
```

**PowerShell:**

```powershell
py -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements-benchmark.txt
```

**Bash:**

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-benchmark.txt
```

Nếu Ubuntu thiếu module venv, cài gói `python3-venv` bằng trình quản lý gói của máy rồi chạy lại. Không chạy pip với sudo.

## 3. Đưa Full PLY và Tile PLY thật vào web

Thay hai đường dẫn input bằng **thư mục thật của bạn**, không trỏ vào thư mục ZIP chưa giải nén. Script dò file hiện có, đọc header/body PLY, ghi kích thước, số Gaussian, SHA-256, danh sách thuộc tính, bậc SH và bounds tâm Gaussian. Không giả định đủ 64 tile. Các tên res/layer là phiên bản thay thế, không cộng dồn.

Ví dụ cây được nhận:

```text
full/res1/001450.ply
full/res2/001450.ply
full/res4/001450.ply
full/res8/001450.ply

tiles/frame_1450/layer_1/voxels_new/<ten-tile-bat-ky>.ply
tiles/layer_2/frame_1450/voxels_new/<ten-tile-bat-ky>.ply
```

Cũng nhận thư mục chứa `res1` trong tên như `tile30_res1_x/f1450/point_cloud/iteration_30000/point_cloud.ply` khi đó là **Gaussian PLY đầy đủ**, không phải một phần mã nén. Có nhiều export trùng frame thì script từ chối thay vì tự chọn nhầm. Chỉ đọc iteration_30000 khi có tên iteration; sửa nguồn hoặc chọn root riêng nếu cần iteration khác.

**CMD — nhập full trước, tile sau:**

```bat
.venv\Scripts\python.exe configure_benchmark.py --full-root "D:\3DGS-Spark-Vibe ver2\dist\data\redandblack-pages" --res res1,res2,res4,res8 --start 1450 --end 1479 --copy
.venv\Scripts\python.exe configure_benchmark.py --tiles-root "D:\Downloads\redandblack_tiles" --tile-dir voxels_new --res res1,res2,res4,res8 --start 1450 --end 1479 --copy
.venv\Scripts\python.exe serve_benchmark.py --bind 127.0.0.1 --port 8765 --directory dist
```

**PowerShell:**

```powershell
& .\.venv\Scripts\python.exe configure_benchmark.py --full-root "D:\3DGS-Spark-Vibe ver2\dist\data\redandblack-pages" --res res1,res2,res4,res8 --start 1450 --end 1479 --copy
& .\.venv\Scripts\python.exe configure_benchmark.py --tiles-root "D:\Downloads\redandblack_tiles" --tile-dir voxels_new --res res1,res2,res4,res8 --start 1450 --end 1479 --copy
& .\.venv\Scripts\python.exe serve_benchmark.py --bind 127.0.0.1 --port 8765 --directory dist
```

**Ubuntu / Bash** — sửa `/duong/dan/...` trước khi chạy. `--link` tiết kiệm dung lượng, giữ dữ liệu gốc ở nguyên vị trí:

```bash
.venv/bin/python configure_benchmark.py \
  --full-root "/duong/dan/redandblack-full" \
  --res res1,res2,res4,res8 --start 1450 --end 1479 --link

.venv/bin/python configure_benchmark.py \
  --tiles-root "/duong/dan/redandblack_tiles" --tile-dir voxels_new \
  --res res1,res2,res4,res8 --start 1450 --end 1479 --link

.venv/bin/python serve_benchmark.py --bind 127.0.0.1 --port 8765 --directory dist
```

Hoặc cấu hình cả hai trong **một lệnh**:

```bash
.venv/bin/python configure_benchmark.py --full-root "/duong/dan/full" --tiles-root "/duong/dan/tiles" --tile-dir voxels_new --res res1,res2,res4,res8 --start 1450 --end 1479 --link
```

Nếu tile không nằm trong `voxels_new`, bỏ `--tile-dir voxels_new` hoặc thay bằng tên thư mục thật. Root phải bao được cả bốn res. Frontend không chứa đường dẫn `/home/minh/...`; chỉ manifest HTTP tương đối trỏ đến file đã copy/link.

Sau bước full đầu tiên, dữ liệu chưa được đối chiếu với tile; mặc định UI từ chối baseline. Sau bước tile, script kiểm tra **multiset chính xác của mọi thuộc tính scalar trên mọi Gaussian**, không phụ thuộc thứ tự vertex. Mặc định phải đủ 120 cặp. Phát hiện trùng Gaussian ở biên, thiếu điểm hoặc sửa thuộc tính thì script báo lỗi, không coi hai treatment tương đương. Đọc JSON `voxel_new.json`/`metadata.json`/`manifest.json` cạnh tile nếu có và giữ trong manifest. Bounds tính từ tâm Gaussian không đủ để loại theo frustum; baseline tải toàn bộ tile.

`--copy` tạo bản sao có thể chuyển máy/deploy. `--link` chỉ dùng local: ZIP hay GitHub Pages không tự mang theo dữ liệu đích của symlink. Không di chuyển/xóa dữ liệu gốc khi dùng link. Gói ZIP nguồn hiện tại không chứa redandblack riêng của bạn.

PLY hỗ trợ: ASCII hoặc binary little-endian, vertex-only, scalar properties, SH0–SH3. Mesh/list property, big-endian, dữ liệu thiếu opacity/scale/rotation/SH bị từ chối rõ ràng. Chuẩn bị offline có thể dùng RAM đáng kể: giữ một frame full và các tile để đối chiếu, không giữ cả dataset trong RAM.

## 4. Nếu mới có Full PLY: tạo tile để đối chiếu công bằng

Đây là chia theo tâm trên **một lưới chung**, không nén/giảm Gaussian và không loại SH. Mỗi Gaussian có đúng một ô sở hữu; không nhân đôi tại biên. File full gốc được giữ nguyên.

**Bash:**

```bash
.venv/bin/python split_benchmark_tiles.py --input "/duong/dan/full" --output "/duong/dan/tiles-baseline" --grid 4,4,4
.venv/bin/python configure_benchmark.py --full-root "/duong/dan/full" --tiles-root "/duong/dan/tiles-baseline" --tile-dir voxels_new --res res1,res2,res4,res8 --start 1450 --end 1479 --link
```

**CMD:**

```bat
.venv\Scripts\python.exe split_benchmark_tiles.py --input "D:\data\full" --output "D:\data\tiles-baseline" --grid 4,4,4
.venv\Scripts\python.exe configure_benchmark.py --full-root "D:\data\full" --tiles-root "D:\data\tiles-baseline" --tile-dir voxels_new --copy
```

Đầu ra splitter phải là thư mục mới/rỗng bên ngoài input. Lưới 4×4×4 có tối đa 64 ô; chỉ ghi ô có Gaussian.

## 5. Cách chạy phép đo

1. Chọn scene thật, res, FPS, fixed camera hoặc trace; cùng cấu hình cho A/B.
2. Chọn cache case rõ ràng. `no-store` bỏ app cache và yêu cầu fetch no-store; nó không chứng minh OS/server/DNS đều cold. Muốn HTTP cold, dùng DevTools/Browser mới theo protocol.
3. Chọn budget đủ current + next và startup. Web từ chối ngân sách quá nhỏ, không chờ vô hạn. Prefetch mặc định 8, startup 2, HTTP 6, app prepare 2; Worker pool nội bộ Spark là tầng khác.
4. Bấm **5 cặp A/B**: tạo 10 run ID riêng, thứ tự AB/BA luân phiên, không loop. Giữ tab hiển thị; chuyển tab làm run `invalid_visibility`. Batch không tự đặt mạng, không xóa được HTTP cache.
5. Đợi kết thúc rồi **Xuất ZIP / CSV**. Không nén ZIP trong lúc chạy speed benchmark.

UI khóa cấu hình khi đang chạy. Seek/pause hoạt động; với baseline không thao tác giữa run. Camera orbit/zoom/pan chỉ trong chế độ manual và là exploratory. Trace JSON chứa `at_ms`, `position`, `target`, cùng time origin main thread tương đối run; không có đồng hồ Worker ghép tùy tiện.

Pipeline: HTTP bytes → app gate → `SplatMesh.initialized` (gộp Worker parse/pack/copy/wait) → cache mesh → khi tới lượt, submit source texture + `await SparkRenderer.update()` → draw submit. Chuẩn bị trước không đồng nghĩa mọi GPU update/sort đã được chuẩn bị trước. Giữ frame hoàn chỉnh gần nhất khi chậm, không phát lẫn tile của các thời điểm, không bỏ frame để giả tạo FPS. Đây là buffer trượt; không có nén liên frame/GOP.

Mỗi run có `metadata.json`, `summary.json`, `field_status.json`, `requests.csv`, `frames.csv`, `tiles.csv`, `renders.csv`, `samples.csv`, `events.jsonl`. Đọc [METRICS.md](METRICS.md) và [BENCHMARK_PROTOCOL.md](BENCHMARK_PROTOCOL.md) trước khi đưa số vào báo cáo.

## 6. Tổng hợp nhiều run và so sánh ảnh

```bash
.venv/bin/python summarize_benchmarks.py ketqua-A-B.zip --output comparison.json
```

Xuất JSON + CSV, nhóm theo cấu hình/dataset/camera/renderer, tách treatment, kiểm tra số run độc lập tối thiểu 5. Chỉ nhận completed và log đầy đủ; giữ danh sách loại bỏ. p95 cần ≥20 mẫu, p99 ≥100; không lấy 30 frame trong cùng run làm 30 lần lặp độc lập.

**Ảnh chất lượng chạy riêng**: mở mục đánh giá ảnh, capture lần lượt Full/Tile cùng res/camera/canvas. Giải nén hai ZIP rồi:

```bash
.venv/bin/python -m pip install -r requirements-quality.txt
.venv/bin/python evaluate_captures.py --reference "captures-full" --candidate "captures-tiles" --output quality.csv
```

Ảnh đồng nhất có PSNR vô hạn: CSV để trống PSNR và ghi lý do, SSIM=1. LPIPS tùy chọn `--lpips` yêu cầu tự cài `torch` và `lpips`; trọng số model có thể cần tải mạng. Không gọi Full PLY là ground truth. Capture riêng không được dùng để tính throughput/FPS benchmark.

## 7. Thêm scene và chốt phiên bản

Dùng `--scene-id scene-moi --name "Scene mới" --output dist/bench/data/scene-moi/manifest.json` với script cấu hình. Catalog được cập nhật nếu đầu ra theo cấu trúc này; frontend đọc catalog/manifest, không sửa UI JS. `--camera camera.json` nhận position/target/up/fov/near/far; `--rotation 180` dùng chung mọi treatment. Mặc định camera được tính từ dữ liệu ở lần cấu hình đầu và giữ khi nhập tiếp tile. Nếu đổi hệ tọa độ/rotation sau đó, truyền camera tương ứng.

Không có Auto/res ABR hoặc Spark LoD trong benchmark này: lựa chọn res cố định và Spark `enableLod:false`. Việc thêm ABR/viewport/progressive sẽ tạo điều kiện nghiên cứu mới; không trộn với baseline full-vs-tile hiện tại.

Vendors: Spark 2.3.1 tag v2.3.1, Three 0.180.0, fflate 0.8.2. Giữ giấy phép trong vendor. Nguồn sơ cấp và phạm vi API ở [SOURCES-BENCHMARK.md](SOURCES-BENCHMARK.md).

## 8. Kiểm thử và đóng lại ZIP

Node chỉ cần khi chạy unit tests, không cần để mở web:

```bash
node --test benchmark-tests/*.test.mjs
.venv/bin/python -m pip install -r requirements-quality.txt
.venv/bin/python -m unittest discover -s benchmark-tests -p 'test_*.py'
.venv/bin/python package_benchmark.py
```

Tại Windows CMD dùng `.venv\Scripts\python.exe`, PowerShell dùng `& .\.venv\Scripts\python.exe`. Dùng dấu nháy kép cho pattern Python trong CMD.

Xem [VALIDATION-BENCHMARK.md](VALIDATION-BENCHMARK.md) về kiểm tra thực sự đã chạy. Chưa có dataset redandblack thật và môi trường QA tắt WebGL: không khẳng định đạt 30 FPS hoặc tile nhanh hơn full. Nếu vẫn chậm, dùng timing từng tầng để xác định HTTP, app decode gate, combined parse/pack wall, Spark update và draw submit; không suy ra CPU/GPU utilization từ FPS hay htop riêng.
