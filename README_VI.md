# ainovel-cli

<p align="center">
  <a href="README.md">English</a> |
  <b>Tiếng Việt</b> |
  <a href="README_ZH.md">中文</a>
</p>

<p align="center">
  <strong>Engine sáng tác tiểu thuyết dài tập bằng AI hoàn toàn tự động.</strong><br>
  Máy trạng thái tất định điều phối các tác nhân AI độc lập (Architect, Writer, Editor) kết hợp trọng tài ngữ nghĩa (Arbiter), đưa tác phẩm từ một câu ý tưởng ban đầu đến bộ tiểu thuyết hoàn chỉnh nhiều tập mà không cần can thiệp thủ công.
</p>

<p align="center">
  <img src="scripts/sample.gif" alt="ainovel-cli demo" width="800">
  <img src="scripts/novel.png" alt="ainovel-cli bg" width="800">
</p>

---

## Mục lục

- [Tính năng nổi bật](#tính-năng-nổi-bật)
- [Kiến trúc & Quy trình hoạt động](#kiến-trúc--quy-trình-hoạt-động)
  - [Nguyên tắc cốt lõi](#nguyên-tắc-cốt-lõi)
  - [Vai trò của các Tác nhân (Agents)](#vai-trò-của-các-tác-nhân-agents)
  - [Quy trình viết một chương](#quy-trình-viết-một-chương)
  - [Quy hoạch dài tập cuộn 2 tầng (Rolling Planning)](#quy-hoạch-dài-tập-cuộn-2-tầng-rolling-planning)
  - [Quản lý ngữ cảnh phân tầng & Nén chủ động](#quản-lý-ngữ-cảnh-phân-tầng--nén-chủ-động)
- [Bắt đầu nhanh](#bắt-đầu-nhanh)
  - [Cài đặt](#cài-đặt)
  - [Thiết lập ban đầu](#thiết-lập-ban-đầu)
  - [Tham số dòng lệnh (CLI Flags)](#tham-số-dòng-lệnh-cli-flags)
  - [Chế độ Headless (Chạy ngầm trên Server / CI / VPS)](#chế-độ-headless-chạy-ngầm-trên-server--ci--vps)
  - [Docker & Docker Compose](#docker--docker-compose)
- [Giao diện TUI & Danh sách lệnh (Slash Commands)](#giao-diện-tui--danh-sách-lệnh-slash-commands)
- [Hướng dẫn cấu hình](#hướng-dẫn-cấu-hình)
  - [Thứ tự ưu tiên nạp cấu hình](#thứ-tự-ưu-tiên-nạp-cấu-hình)
  - [Mẫu tệp cấu hình hoàn chỉnh](#mẫu-tệp-cấu-hình-hoàn-chỉnh)
  - [Phân bổ mô hình theo vai trò (Role-Based Routing) & Dự phòng](#phân-bổ-mô-hình-theo-vai-trò-role-based-routing--dự-phòng)
  - [Cấu hình Proxy & Cổng trung gian tùy chỉnh](#cấu-hình-proxy--cổng-trung-gian-tùy-chỉnh)
- [Tính năng nâng cao](#tính-năng-nâng-cao)
  - [Nhập & Tái cấu trúc tiểu thuyết có sẵn (`/import`)](#nhập--tái-cấu-trúc-tiểu-thuyết-có-sẵn-import)
  - [Trích xuất & Mô phỏng văn phong (`/simulate`)](#trích-xuất--mô-phỏng-văn-phong-simulate)
  - [Đồng bộ chỉnh sửa thủ công của người dùng (`/sync`)](#đồng-bộ-chỉnh-sửa-thủ-công-của-người-dùng-sync)
  - [Cổng duyệt từng chương (`/review`)](#cổng-duyệt-từng-chương-review)
  - [Can thiệp thời gian thực (Steer)](#can-thiệp-thời-gian-thực-steer)
  - [Xuất bản tác phẩm đa định dạng (`/export`)](#xuất-bản-tác-phẩm-đa-định-dạng-export)
  - [Tầng văn phong (Voice Layer) & Thể loại tùy chỉnh](#tầng-văn-phong-voice-layer--thể-loại-tùy-chỉnh)
  - [Khử giọng điệu AI & Quy tắc người dùng tùy chỉnh](#khử-giọng-điệu-ai--quy-tắc-người-dùng-tùy-chỉnh)
  - [Báo cáo chẩn đoán sức khỏe tác phẩm (`/diag`)](#báo-cáo-chẩn-đoán-sức-khỏe-tác-phẩm-diag)
  - [Kiểm soát ngân sách & Thông báo không người trực](#kiểm-soát-ngân-sách--thông-báo-không-người-trực)
  - [Hệ thống đánh giá & Benchmark ngoại tuyến (`eval`)](#hệ-thống-đánh-giá--benchmark-ngoại-tuyến-eval)
- [Cấu trúc thư mục đầu ra (Output)](#cấu-trúc-thư-mục-đầu-ra-output)
- [Khả năng phục hồi sự cố & Lưu trữ bền vững](#khả-năng-phục-hồi-sự-cố--lưu-trữ-bền-vững)
- [Công nghệ sử dụng](#công-nghệ-sử-dụng)
- [Giấy phép (License)](#giấy-phép-license)

---

## Tính năng nổi bật

- **Engine tất định + Đa tác nhân cộng tác**: Vòng lặp điều phối chính hoàn toàn bằng mã nguồn tất định, không tiêu tốn token LLM cho việc định tuyến quy trình. Các tác nhân `Architect`, `Writer`, và `Editor` hoạt động tự chủ và có thể kiểm thử toàn diện.
- **Hỗ trợ đa ngôn ngữ nguyên bản (i18n)**:
  - **Giao diện người dùng (UI)**: Hỗ trợ đầy đủ **Tiếng Việt (`vi`)**, **Tiếng Anh (`en`)**, và **Tiếng Trung (`zh`)**.
  - **Ngôn ngữ sáng tác (`--story-lang`)**: Viết tiểu thuyết hoàn toàn bằng **Tiếng Việt tự nhiên** (tích hợp chỉ dẫn văn phong chống dịch thô, tránh lạm dụng từ Hán Việt cứng nhắc, câu từ mượt mà giàu cảm xúc), **Tiếng Anh**, hoặc **Tiếng Trung**.
- **Trọng tài ngữ nghĩa có thể kiểm toán (Arbiter)**: Các quyết định mang tính chiến lược (chọn chiến lược lập kế hoạch, phân loại chỉ đạo của người dùng, xử lý ngõ cụt/lỗi) được giải quyết qua các cuộc gọi LLM hàm đơn lẻ, ghi log kiểm toán tại `meta/decisions.jsonl`.
- **Khôi phục từng bước (Step-Level Checkpoints)**: Mọi thao tác công cụ thành công đều lưu một checkpoint nguyên tử. Khi bị ngắt nguồn, crash hoặc mất mạng, hệ thống khôi phục chính xác tại bước `plan`, `draft`, `check`, hoặc `commit`.
- **Quy hoạch dài tập cuộn 2 tầng (Rolling Planning)**: Không lập dàn ý cứng ngắc cho 300+ chương ngay từ đầu (gây loãng nhịp độ). Hệ thống bắt đầu bằng la bàn định hướng + khung sườn 2 quyển đầu và mở rộng chi tiết các hồi/chương khi truyện tiến triển tới nơi.
- **Đề xuất ngữ cảnh thông minh**: Trước mỗi chương, hệ thống tự động quét và đề xuất các chương lịch sử liên quan dựa trên: phục bút (foreshadowing), sự xuất hiện của nhân vật, biến đổi trạng thái và quan hệ, đảm bảo tính liền mạch cho tác phẩm trên 500 chương.
- **Đánh giá chất lượng 7 chiều**: `Editor` đánh giá tính nhất quán của thế giới quan, hành vi nhân vật, nhịp độ, tính liên tục, phục bút, móc câu cuối chương (hooks) và chất lượng văn học thẩm mỹ (bắt buộc trích dẫn bằng chứng từ văn bản gốc).
- **Can thiệp trực tiếp thời gian thực (Steer)**: Nhập yêu cầu chỉnh sửa vào khung chat TUI bất kỳ lúc nào mà không cần tạm dừng hệ thống; Arbiter sẽ tự động đánh giá phạm vi ảnh hưởng và cập nhật kế hoạch.
- **Cổng duyệt từng chương tùy chọn**: Bật `/review on` để xem xét và đánh giá từng chương trước khi chạy `/next` để sáng tác chương tiếp theo.
- **Nhập & Tái cấu trúc tiểu thuyết có sẵn (`/import`)**: Nhập tệp văn bản `.txt` / `.md`. Hệ thống tự động phân tách chương theo ngữ nghĩa, trích xuất dữ kiện, tái lập hồ sơ nhân vật, thế giới quan và dàn ý để viết tiếp.
- **Trích xuất & Mô phỏng văn phong (`/simulate`)**: Đọc các tác phẩm mẫu để tạo hồ sơ văn phong (từ vựng, nhịp câu, mật độ xung đột, cách đặt móc câu) giúp các tác nhân áp dụng vào câu chuyện mới.
- **Đồng bộ chỉnh sửa thủ công (`/sync`)**: Tự do sửa trực tiếp nội dung các chương đã viết; hệ thống dùng mã băm SHA-256 để nhận diện thay đổi và tự động cập nhật lại toàn bộ mạng lưới dữ kiện nhân vật, tóm tắt.
- **Xuất bản đa định dạng (`/export`)**: Xuất toàn bộ hoặc một đoạn chương ra tệp văn bản TXT sạch hoặc sách điện tử tiêu chuẩn EPUB 3 kèm mục lục.
- **Hỗ trợ đa dạng nhà cung cấp LLM**: Chuyển đổi linh hoạt giữa OpenRouter, Anthropic, Google Gemini, OpenAI, DeepSeek, Qwen, GLM, Grok, Ollama, Bedrock và các cổng Proxy tùy chỉnh.

---

## Kiến trúc & Quy trình hoạt động

### Nguyên tắc cốt lõi

Triết lý kiến trúc: **Tầng dữ kiện tất định, Tầng ngữ nghĩa tự chủ**.
1. **Chuyển dịch trạng thái thuộc về mã nguồn**: Việc quyết định "ai chạy tiếp theo" là hàm thuần túy tra bảng (`flow.Route`), không tốn chi phí LLM và không có sai số logic.
2. **Quyết định ranh giới ngữ nghĩa thuộc về Arbiter**: Các đánh giá chiến lược có cấu trúc được giao cho Arbiter xử lý trong một lượt gọi.
3. **Sáng tác mở thuộc về các Worker**: Writer hoàn toàn tự do trong việc triển khai ý tưởng, miêu tả khung cảnh, hội thoại và diễn biến trong từng chương.
4. **Công cụ chỉ trả về dữ kiện**: Các công cụ ghi tệp nguyên tử và trả về JSON thuần túy, không kèm chuỗi mệnh lệnh.

```
┌─────────────────────────────────────────────────────────────┐
│                    Host / Engine (Tất định)                 │
│  Đọc Store → Định tuyến → Gọi Worker → Lặp vòng             │
│  Khởi động / Phân loại can thiệp / Bế tắc → Gọi Arbiter     │
└──────┬──────────────┬──────────────┬──────────────┬─────────┘
       │              │              │              │
 ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐  ┌────▼─────┐
 │ Architect  │ │   Writer   │ │   Editor   │  │ Arbiter  │
 │ (Vòng LLM) │ │ (Vòng LLM) │ │ (Vòng LLM) │  │  (Hàm)   │
 └─────┬──────┘ └─────┬──────┘ └─────┬──────┘  └──────────┘
       └──────────────┼──────────────┘
                      │ Gọi công cụ (Ghi tệp nguyên tử + Checkpoint)
┌─────────────────────▼───────────────────────────────────────┐
│                          Store                              │
│   Tiến độ / Checkpoints / Dàn ý / Bản thảo / Tóm tắt        │
└─────────────────────────────────────────────────────────────┘
```

### Vai trò của các Tác nhân (Agents)

| Tác nhân | Trách nhiệm chính | Công cụ cốt lõi |
|---|---|---|
| **Arbiter** | Trọng tài ngữ nghĩa: Đánh giá khởi tạo, phân loại chỉ đạo người dùng, gỡ bế tắc/lỗi. | *Không (gọi hàm LLM đơn lẻ xuất dữ liệu có cấu trúc)* |
| **Architect** | Thiết lập thế giới quan, hồ sơ nhân vật, tiền đề, dàn ý đại cương nhiều quyển, mở rộng các hồi. | `novel_context`, `save_book`, `save_foundation` |
| **Writer** | Lên kế hoạch chương, viết bản thảo, kiểm tra tính nhất quán và nộp chương hoàn tất. | `novel_context`, `read_chapter`, `plan_chapter`, `draft_chapter`, `check_consistency`, `commit_chapter` |
| **Editor** | Đọc lại văn bản gốc, đánh giá cấu trúc & thẩm mỹ 7 chiều, tạo tóm tắt hồi và tóm tắt quyển. | `novel_context`, `read_chapter`, `save_review`, `save_arc_summary`, `save_volume_summary` |

### Quy trình viết một chương

```
Ý tưởng người dùng ──► Phân loại Arbiter ──► Architect (Thiết lập / Dàn ý) ──► Writer (Viết từng chương) ──► Editor (Duyệt hồi)
                                                                                       ▲                          │
                                                                                       ├── Viết lại / Trau chuốt ─┘
                                                                                       │
                                                                             Architect (Mở rộng Hồi/Quyển tiếp)
```

Trong mỗi chương, **Writer** tuân thủ nghiêm ngặt trình tự các bước:
1. `novel_context`: Tải ngữ cảnh liên quan (tóm tắt gần nhất, phục bút, trạng thái nhân vật hiện tại, quy tắc văn phong).
2. `read_chapter`: Đọc lại các chương trước để lấy lại nhịp điệu và giọng văn.
3. `plan_chapter`: Lên kế hoạch mục tiêu, xung đột, đường cong cảm xúc của chương.
4. `draft_chapter`: Viết toàn văn nội dung chương.
5. `check_consistency`: Đối chiếu bản nháp với hồ sơ nhân vật và quy tắc thế giới quan.
6. `commit_chapter`: Nộp bản thảo chính thức qua giao dịch Saga nguyên tử, cập nhật tiến độ và dữ kiện.

### Quy hoạch dài tập cuộn 2 tầng (Rolling Planning)

Khác với các hệ thống truyền thống cố tạo dàn ý cho 300+ chương ngay từ đầu, `ainovel-cli` áp dụng cơ chế **La bàn định hướng + Quy hoạch cuộn**:

```
Khởi tạo ban đầu                 Kết thúc một Hồi (Arc)             Kết thúc một Quyển (Volume)
┌─────────────────────────┐    ┌───────────────────────────┐    ┌───────────────────────────┐
│ La bàn đại cục          │    │ Editor đánh giá Hồi       │    │ Editor đánh giá Quyển     │
│ Khung sườn 2 Quyển đầu  │    │ Tóm tắt Hồi + Snapshot NV │    │ Tóm tắt Quyển             │
│ Hồi 1 chi tiết chương   │ ──►│ Architect mở rộng Hồi tiếp│ ──►│ Architect tạo Quyển tiếp  │
│ Nhân vật & Thế giới quan│    │ Writer tiếp tục viết      │    │ & Cập nhật La bàn đại cục │
└─────────────────────────┘    └───────────────────────────┘    └───────────────────────────┘
```

- **La bàn định hướng (Compass)**: Lưu giữ cái đích cuối cùng của câu chuyện, các tuyến truyện dài hạn và quy mô dự kiến.
- **Khung sườn Hồi (Skeleton Arcs)**: Các hồi chưa viết chỉ lưu mục tiêu tổng quát và ước lượng số chương; chỉ mở rộng chi tiết khi câu chuyện tiến tới nơi.
- **Mịn hóa lũy tiến**: Mỗi lần mở rộng đều dựa trên tóm tắt thực tế đã viết và trạng thái phát triển của nhân vật.

### Quản lý ngữ cảnh phân tầng & Nén chủ động

- **Tóm tắt chương**: Tóm tắt chi tiết 3 chương gần nhất.
- **Tóm tắt hồi**: Đóng gói các sự kiện và dấu mốc quan trọng ở tầm trung.
- **Tóm tắt quyển**: Nén ở tầm vĩ mô cho các quyển đã qua.
- **Cơ chế nén chủ động**: Khi độ dài ngữ cảnh đạt **85%** cửa sổ ngữ cảnh của mô hình, hệ thống sẽ tự động kích hoạt nén dữ liệu và dự trữ tối thiểu 8.000 token đệm nhằm tránh hiện tượng suy giảm chú ý (attention degradation) của LLM.

---

## Bắt đầu nhanh

### Cài đặt

```bash
# Cài đặt tự động 1 dòng lệnh (macOS / Linux, không cần cài trước Go)
curl -fsSL https://raw.githubusercontent.com/voocel/ainovel-cli/main/scripts/install.sh | sh

# Cài đặt một phiên bản phát hành cụ thể
curl -fsSL https://raw.githubusercontent.com/voocel/ainovel-cli/main/scripts/install.sh | sh -s -- v1.2.3

# Hoặc cài đặt thông qua Go (khuyến nghị Go 1.25+)
go install github.com/voocel/ainovel-cli/cmd/ainovel-cli@latest

# Kiểm tra phiên bản hoặc tự động cập nhật
ainovel-cli --version
ainovel-cli update
```

> **Người dùng Windows**: Tải trực tiếp tệp thực thi nén sẵn từ [GitHub Releases](https://github.com/voocel/ainovel-cli/releases/latest).

### Thiết lập ban đầu

Chạy lệnh `ainovel-cli` trong một thư mục trống. Trình hướng dẫn tương tác sẽ tự động xuất hiện nếu chưa có tệp cấu hình:
1. Chọn Provider chính (OpenRouter, Anthropic, Gemini, OpenAI, DeepSeek, Ollama, v.v.).
2. Nhập API Key và Base URL.
3. Chọn mô hình mặc định.

```bash
ainovel-cli
```

### Tham số dòng lệnh (CLI Flags)

```bash
# Thiết lập ngôn ngữ giao diện (vi, en, zh - mặc định: tự nhận diện theo hệ máy hoặc vi)
ainovel-cli --lang vi
ainovel-cli -l vi

# Thiết lập ngôn ngữ sáng tác truyện (vi, en, zh - mặc định: theo ngôn ngữ giao diện)
ainovel-cli --story-lang vi    # Sáng tác tiếng Việt chuẩn văn phong tự nhiên
ainovel-cli --story-lang en    # Sáng tác tiếng Anh
ainovel-cli --story-lang zh    # Sáng tác tiếng Trung

# Kiểm tra phiên bản
ainovel-cli --version

# Tự động cập nhật lên bản mới nhất từ GitHub
ainovel-cli update
```

### Chế độ Headless (Chạy ngầm trên Server / CI / VPS)

Tham số `--headless` cho phép chạy quá trình sáng tác không cần giao diện TUI:

```bash
# Bắt đầu truyện mới từ một lời nhắc ngắn
ainovel-cli --headless --prompt "Viết tiểu thuyết tiên hiệp tu chân, nhân vật chính bắt đầu từ một đệ tử ngoại môn có tính cách cẩn trọng"

# Bắt đầu truyện từ tệp đề cương/tiền đề có sẵn
ainovel-cli --headless --prompt-file ./de-cuong.txt

# Đọc prompt từ luồng stdin
cat ./prompt.txt | ainovel-cli --headless --prompt-file -

# Tiếp tục viết truyện chưa hoàn thành trong thư mục hiện tại
ainovel-cli --headless
```

### Docker & Docker Compose

Chạy `ainovel-cli` trong môi trường Docker cách ly:

```bash
mkdir -p config workspace

# Chế độ giao diện TUI tương tác
docker run --rm -it \
  -v "$PWD/config:/root/.ainovel" \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/voocel/ainovel-cli:latest

# Chế độ Headless chạy ngầm
docker run --rm \
  -v "$PWD/config:/root/.ainovel" \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/voocel/ainovel-cli:latest \
  --headless --prompt "Viết tiểu thuyết trinh thám hình sự tại Sài Gòn thập niên 90"
```

Sử dụng Docker Compose:

```yaml
services:
  ainovel:
    image: ghcr.io/voocel/ainovel-cli:latest
    stdin_open: true
    tty: true
    volumes:
      - ./config:/root/.ainovel
      - ./workspace:/workspace
```

```bash
docker compose run --rm ainovel
```

---

## Giao diện TUI & Danh sách lệnh (Slash Commands)

Trong giao diện TUI, nhập dấu `/` để mở bảng danh sách lệnh nhanh.

| Lệnh | Cú pháp | Mô tả chi tiết |
|---|---|---|
| `/help` | `/help` | Xem danh sách lệnh và các phím tắt hệ thống. |
| `/model` | `/model [role]` | Mở bảng tương tác để chuyển đổi Provider, Mô hình và Độ suy luận (Thinking) cho từng vai trò (`architect`, `writer`, `editor`, hoặc `default`). |
| `/config` | `/config` | Mở bảng cài đặt ngôn ngữ UI/Sáng tác, danh mục Provider, danh sách Model và tham số hệ thống. |
| `/diag` | `/diag` | Chẩn đoán sức khỏe tác phẩm và xuất báo cáo ẩn danh dữ liệu (`meta/diag-export.md`). |
| `/review` | `/review on\|off` | Bật/tắt chế độ duyệt từng chương. |
| `/next` | `/next` | Cấp phép viết chương tiếp theo khi đang ở chế độ duyệt từng chương. |
| `/start` | `/start <path>` | Tạo truyện mới từ tệp dàn ý/thiết lập tại màn hình chào mừng. |
| `/import` | `/import <path> [--yes] [--story=open\|closed] [--continue] [--guide="..."]` | Nhập tiểu thuyết TXT/MD từ bên ngoài và tái cấu trúc vào hệ thống. |
| `/reopen` | `/reopen [hướng viết tiếp]` | Mở lại một bộ truyện đã hoàn thành để viết tiếp các quyển mới. |
| `/cocreate` | `/cocreate` (hoặc `/plan`) | Tạm dừng sáng tác để vào chế độ đồng sáng tạo, thảo luận hướng phát triển với Architect. |
| `/simulate` | `/simulate` | Đọc các văn bản mẫu trong thư mục `./simulate/` để tạo hồ sơ mô phỏng văn phong. |
| `/importsim` | `/importsim <profile.json>` | Nhập một tệp hồ sơ mô phỏng văn phong có sẵn. |
| `/sync` | `/sync [--check]` | Kiểm tra hoặc tiếp nhận các sửa đổi thủ công của người dùng trong các chương đã viết. |
| `/export` | `/export [path] [from=N] [to=M] [--overwrite]` | Xuất các chương đã hoàn thành ra tệp TXT hoặc sách điện tử EPUB. |

### Phím tắt thao tác TUI

- `Tab` / `Shift+Tab`: Chuyển đổi tiêu điểm giữa các ô nhập liệu / bảng điều khiển.
- `↑` / `↓` / `←` / `→`: Điều hướng danh sách, cuộn nội dung, đổi lựa chọn.
- `Enter`: Gửi lệnh / Xác nhận lựa chọn.
- `Esc`: Đóng cửa sổ modal / Hủy tác vụ hiện tại.
- `Ctrl+R`: Bật/tắt chế độ sao chép bằng chuột trong terminal.

---

## Hướng dẫn cấu hình

### Thứ tự ưu tiên nạp cấu hình

1. `~/.ainovel/config.json`: Cấu hình toàn cục trên máy người dùng.
2. `./.ainovel/config.json`: Cấu hình cấp dự án (ghi đè cấu hình toàn cục).

### Mẫu tệp cấu hình hoàn chỉnh

Xem tệp mẫu có chú thích chi tiết tại `config.example.jsonc`:

```jsonc
{
  "provider": "openrouter",
  "model": "google/gemini-2.5-flash",
  "reasoning_effort": "medium", // off / low / medium / high / xhigh / max

  // Thiết lập ngôn ngữ
  "language": "vi",       // Ngôn ngữ giao diện: vi / en / zh
  "story_language": "vi", // Ngôn ngữ sáng tác: vi / en / zh

  // Thể loại mặc định
  "style": "default",

  "providers": {
    "openrouter": {
      "api_key": "sk-or-v1-xxx",
      "base_url": "https://openrouter.ai/api/v1",
      "models": [
        { "name": "google/gemini-2.5-flash", "context_window": 200000 },
        { "name": "google/gemini-2.5-pro", "context_window": 1000000 }
      ]
    },
    "anthropic": {
      "api_key": "sk-ant-xxx",
      "models": [{ "name": "claude-sonnet-4-6", "json_schema": true }]
    },
    "ollama": {
      "base_url": "http://localhost:11434/v1",
      "models": [{ "name": "qwen3:14b", "context_window": 32768 }],
      "stream_idle_timeout": "15m"
    }
  },

  // Tùy chọn: Chỉ định mô hình riêng theo vai trò
  "roles": {
    "writer": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "reasoning_effort": "high",
      "fallbacks": [{ "provider": "openrouter", "model": "google/gemini-2.5-pro" }]
    },
    "architect": {
      "provider": "openrouter",
      "model": "google/gemini-2.5-pro",
      "reasoning_effort": "medium"
    }
  },

  // Tùy chọn: Hạn mức ngân sách USD cho cuốn sách
  "budget": {
    "book_usd": 50,
    "warn_ratio": 0.8,
    "hard_stop": false
  },

  // Tùy chọn: Kênh cảnh báo tự động
  "notify": {
    "enabled": true,
    "events": ["run_end", "budget", "advance_gate", "worker_failure"]
  }
}
```

### Phân bổ mô hình theo vai trò (Role-Based Routing) & Dự phòng

Bạn có thể tối ưu chi phí và chất lượng bằng cách gán từng mô hình cho từng tác nhân:
- `architect`: Dùng mô hình có khả năng suy luận cao để xây dựng thế giới quan và lập dàn ý đại cương nhiều quyển.
- `writer`: Dùng mô hình có khả năng biểu đạt văn học mượt mà, ghi nhớ ngữ cảnh sâu.
- `editor`: Dùng mô hình có năng lực phân tích phản biện sắc bén để soát lỗi nhất quán.
- `import_segment`, `import_analyze`, `import_synthesize`: Tùy chọn chỉ định mô hình tiết kiệm hơn cho quy trình nhập truyện.

### Cấu hình Proxy & Cổng trung gian tùy chỉnh

Hỗ trợ các cổng trung gian (NewAPI, OneAPI, Claude Code proxy, Codex gateway):

```jsonc
"providers": {
  "my-proxy": {
    "type": "openai", // "openai" hoặc "anthropic"
    "api_key": "sk-xxx",
    "base_url": "https://proxy.example.com/v1",
    "api": "chat",    // "chat" (mặc định) hoặc "responses"
    "extra": {
      "headers": { "X-Custom-Header": "value" },
      "user_agent": "my-client/1.0"
    }
  }
}
```

---

## Tính năng nâng cao

### Nhập & Tái cấu trúc tiểu thuyết có sẵn (`/import`)

Nhập tệp tiểu thuyết `.txt` hoặc `.md` để hệ thống phân tích và viết tiếp:

```text
/import ~/tieuthuyet.txt
```

**Các giai đoạn xử lý**:
1. **Ingest**: Đọc tệp và tự động phát hiện bảng mã (UTF-8 / GB18030).
2. **Segment**: LLM nhận diện ranh giới các chương dựa trên ngữ nghĩa (không phụ thuộc biểu thức chính quy dễ gãy).
3. **Analyze**: Trích xuất dữ kiện từng chương theo lô (sự kiện chính, nhân vật, mốc thời gian).
4. **Synthesize**: Tổng hợp tiền đề toàn tác phẩm, quy tắc thế giới quan, hồ sơ nhân vật và dàn ý phân tầng.
5. **Publish**: Lưu chính thức vào thư mục `output/novel/` để sẵn sàng viết tiếp.

### Trích xuất & Mô phỏng văn phong (`/simulate`)

Đặt 1-5 chương truyện mẫu hoặc tác phẩm bạn yêu thích vào thư mục `./simulate/` rồi chạy:

```text
/simulate
```

Architect sẽ phân tích và trích xuất tệp `simulation_profile.json` ghi lại: cấu trúc nhịp câu, vốn từ vựng đặc trưng, mật độ xung đột và kỹ thuật đặt móc câu. Các tác nhân sẽ tham chiếu hồ sơ này để sáng tác truyện mới theo đúng phong cách bạn muốn mà không sao chép nguyên văn tên tuổi hay tình tiết gốc.

### Đồng bộ chỉnh sửa thủ công của người dùng (`/sync`)

Khi bạn mở trực tiếp các tệp chương đã hoàn thành tại `output/novel/chapters/*.md` để chỉnh sửa câu từ:

```text
/sync --check    # Kiểm tra xem những chương nào đã bị thay đổi
/sync            # Tiếp nhận sửa đổi, cập nhật lại mạng lưới dữ kiện và trạng thái nhân vật
```

### Cổng duyệt từng chương (`/review`)

Khi bạn muốn kiểm soát chặt chẽ từng chương một:

```text
/review on       # Bật cổng duyệt từng chương
/next            # Phê duyệt và cho phép viết chương tiếp theo
/review off      # Trở lại chế độ tự động viết liên tục
```

### Can thiệp thời gian thực (Steer)

Trong lúc hệ thống đang sáng tác, bạn có thể gõ trực tiếp yêu cầu vào ô nhập liệu TUI và nhấn `Enter`:

```text
❯ Cho nhân vật chính nhận được một thanh kiếm cổ ở chương 5 và tăng cường độ căng thẳng trong đối thoại.
```

**Arbiter** sẽ thẩm định:
- Chuyển yêu cầu sửa đổi thiết lập cho **Architect**.
- Đưa các chương đã viết cần sửa lại vào hàng đợi của **Editor** / **Writer**.
- Ghi nhận ngay lập tức các quy tắc sáng tác mới vào bộ nhớ.

### Xuất bản tác phẩm đa định dạng (`/export`)

```text
/export                         # Xuất ra tệp TXT mặc định tại output/novel/{ten_sach}.txt
/export ~/TruyenCuaToi.epub     # Xuất ra sách điện tử EPUB 3 tiêu chuẩn có mục lục và metadata
/export from=1 to=50 ~/Phan1.epub --overwrite
```

### Tầng văn phong (Voice Layer) & Thể loại tùy chỉnh

Tùy biến tiêu chuẩn hành văn mà không cần sửa mã nguồn hệ thống. Cơ chế ghi đè hoạt động theo 3 cấp độ: `Mặc định có sẵn < Toàn cục ~/.ainovel/style/ < Cấp cuốn sách ./style/`:

```
style/
├── voice.md                    # Tiêu chuẩn hành văn bổ sung
├── anti-ai-tone.md             # Tiêu chí khử mùi AI bổ sung
├── styles/
│   └── kiemhiep-uam.md         # Thể loại tùy chỉnh mới
└── genres/
    └── kiemhiep-uam/
        └── style-references.md # Tài liệu tham khảo thể loại
```

**Các thể loại có sẵn**: `default` (Mặc định), `tienhiep` (Tiên hiệp), `kiemhiep` (Kiếm hiệp), `dothi` (Đô thị), `ngontinh` (Ngôn tình), `trinhtham` (Trinh thám), `fantasy`, `suspense`, `romance`.

### Khử giọng điệu AI & Quy tắc người dùng tùy chỉnh

Để thiết lập các quy tắc bắt buộc (ví dụ: "Mỗi chương khoảng 3.000 chữ", "Không dùng các câu hỏi tu từ sáo rỗng", "Nhân vật chính quyết đoán, không nhân nhượng kẻ địch"), bạn chỉ cần viết các tệp Markdown bằng ngôn ngữ tự nhiên vào:
- Cấu hình toàn cục: `~/.ainovel/rules/*.md`
- Cấu hình từng truyện: `./.ainovel/rules/*.md`

Hệ thống sẽ tự động chuyển hóa thành các ràng buộc có cấu trúc và kiểm tra cơ học mỗi khi Writer nộp chương.

### Báo cáo chẩn đoán sức khỏe tác phẩm (`/diag`)

Chạy lệnh `/diag` để quét toàn bộ dữ liệu truyện: kiểm tra bế tắc mạch truyện, nhân vật bị lãng quên, đứt gãy dòng thời gian. Hệ thống xuất ra tệp báo cáo đã ẩn danh dữ liệu tại `output/novel/meta/diag-export.md` để bạn dễ dàng gửi đính kèm khi báo lỗi trên GitHub.

### Kiểm soát ngân sách & Thông báo không người trực

- **Ngân sách**: Cấu hình `book_usd` trong `config.json` để giới hạn số tiền tối đa chi cho một cuốn sách.
- **Thông báo**: Hỗ trợ thông báo qua hệ điều hành (macOS `osascript`, Linux `notify-send`, Windows), ứng dụng di động Bark (iOS), ntfy (Android/iOS), hoặc lệnh webhook `curl` tùy chỉnh.

### Hệ thống đánh giá & Benchmark ngoại tuyến (`eval`)

Bộ công cụ harness tích hợp sẵn để đánh giá và benchmark chất lượng mô hình cũng như kiểm thử A/B prompt:

```bash
ainovel-cli eval --dataset ./benchmarks/prompt_suite.json --model anthropic/claude-sonnet-4-6
```

---

## Cấu trúc thư mục đầu ra (Output)

Mỗi cuốn tiểu thuyết được lưu trữ độc lập trong thư mục không gian làm việc:

```
output/novel/
├── book.md                   # Tên sách và giới thiệu truyện
├── chapters/                 # Các chương đã hoàn thành chính thức (Markdown)
│   ├── 01.md
│   └── ...
├── drafts/                   # Bản thảo tạm thời
├── reviews/                  # Báo cáo đánh giá của Editor
├── summaries/                # Tóm tắt Chương, Hồi, Quyển (JSON)
├── timeline.jsonl            # Nhật ký dòng thời gian chi tiết
├── premise.md                # Tiền đề câu chuyện
├── layered_outline.json      # Dàn ý phân tầng nhiều quyển
├── characters.json           # Hồ sơ nhân vật và sổ cái trạng thái
├── world_rules.json          # Quy tắc thế giới quan và hệ thống sức mạnh
└── meta/
    ├── book.json             # Nguồn chân lý duy nhất cho thông tin tác phẩm
    ├── compass.json          # La bàn định hướng dài hạn
    ├── progress.json         # Trạng thái tiến độ hiện tại
    ├── foreshadow.json       # Bảng theo dõi phục bút
    ├── checkpoints.jsonl     # Điểm khôi phục nguyên tử từng bước
    └── decisions.jsonl       # Sổ cái kiểm toán quyết định của Arbiter
```

---

## Khả năng phục hồi sự cố & Lưu trữ bền vững

Viết một bộ tiểu thuyết 500 chương có thể mất nhiều ngày. `ainovel-cli` được thiết kế với độ bền chuẩn công nghiệp:
- **Ghi tệp nguyên tử**: Mọi thao tác ghi tệp đều qua `temp + fsync + rename`, chống hỏng dữ liệu ngay cả khi mất điện đột ngột.
- **Checkpoint từng bước**: Lưu vết sau mỗi thao tác công cụ thành công.
- **Không phụ thuộc Session bộ nhớ**: Khởi động lại `ainovel-cli` trong cùng thư mục sẽ đọc lại kho lưu trữ và tiếp tục viết một cách liền mạch.

---

## Công nghệ sử dụng

- **[Go 1.25+](https://golang.org/)**: Ngôn ngữ lập trình chính hiệu năng cao, xử lý đồng thời vượt trội.
- **[agentcore](https://github.com/voocel/agentcore)**: Nhân Agent siêu tinh gọn xử lý tool-calling và streaming.
- **[litellm](https://github.com/voocel/litellm)**: Bộ chuyển đổi API LLM thống nhất.
- **[Bubble Tea](https://github.com/charmbracelet/bubbletea)** & **[Lipgloss](https://github.com/charmbracelet/lipgloss)**: Khung giao diện TUI hiện đại trong terminal.

---

## Giấy phép (License)

Dự án được phân phối mã nguồn mở theo [Giấy phép MIT](LICENSE).

Cộng đồng thảo luận và hỗ trợ tại [linux.do](https://linux.do/).
