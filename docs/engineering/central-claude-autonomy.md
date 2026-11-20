# Bot tự merge dùng chung (`claude-autonomy.yml`)

Bot này **không dùng AI**: chỉ là mã quy tắc xác định. Nó chỉ merge khi mọi bằng chứng, được kéo lại từ API ngay lúc đó, đều khớp đúng HEAD của PR. Chỉ có **một** controller; mọi repo gọi lại nó bằng caller mỏng `nexagnet-claude-autonomy.yml` (do `scripts/bootstrap-repo.sh` thêm).

## Luồng

`ci` xanh → Reviewer chạy → Reviewer đăng bằng chứng `nexagnet-review-evidence` → bot (kích hoạt bởi `workflow_run` của "Nexagnet Reviewer caller") quyết định.

1. **decide** (chỉ đọc, không có secret): kiểm tra run Reviewer, bằng chứng, PR, CI, ruleset, danh sách file. Ra quyết định `MERGE`, `MANUAL` hoặc `NONE`.
2. **merge** (chỉ khi `MERGE`): kéo lại toàn bộ trạng thái lần nữa, *sau đó mới* tạo token GitHub App (giới hạn đúng repo này, Contents và Pull requests: write), rồi gọi `PUT /pulls/N/merge` **một lần** với `sha=<HEAD mong đợi>`, squash. Không `--auto`, không `--admin`, không bypass, không retry. Cuối cùng kéo lại PR và xác nhận `merged == true` (không tin mã thoát).
3. **notify**: đăng đúng một comment cố định cho mỗi HEAD (`READY_FOR_MANUAL_MERGE ...` hoặc `AUTO_MERGE_STOPPED ...`), không lặp.

Log chỉ in mã lý do cố định (`AUTONOMY_BLOCKED: <MÃ>`), không in nội dung PR/API/đường dẫn.

## Khi nào *không* merge

| Điều kiện | Kết quả |
| --- | --- |
| Không có bằng chứng (PR Draft, Reviewer bị bỏ qua hay lỗi) | `NONE` (êm, không đỏ) |
| Reviewer không PASS, có finding blocker/major, hoặc không kiểm diff | không merge |
| PR đã đóng/merge, hoặc HEAD khác HEAD được duyệt (PASS cũ) | `NONE` |
| PR là Draft; có nhãn `needs-human` | `NONE` |
| Có run `ci` mới hơn cho cùng HEAD, hoặc thiếu/đỏ job bắt buộc | không merge |
| Tác giả không thuộc danh sách tin cậy (hoặc bot Publisher), PR từ fork, nhánh đích sai | đỏ, không merge |
| Nhánh đích **chưa có ruleset hiệu lực** (pull_request + check bắt buộc, không merge queue) | đỏ `RULESET_MISSING` để chủ thấy cấu hình thiếu |
| PR chạm đường dẫn nhạy cảm | `MANUAL`: chỉ comment `READY_FOR_MANUAL_MERGE`, chủ merge tay |

Đường dẫn nhạy cảm chung: `.github/**`, `.claude/**`, `infra/`, `deploy/`, `tools/autopilot/`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.env*`. Mỗi dự án thêm phần riêng qua `sensitive_paths_regex` (forgeborn-mobile: `^(ProjectSettings/|Packages/manifest\.json|Packages/packages-lock\.json)`).

## Ma trận ca kiểm thử (`tests/claude-autonomy-contract.test.cjs`)

| Ca | Tình huống | Kỳ vọng | Test |
| --- | --- | --- | --- |
| 11 | PR chạm đường dẫn nhạy cảm (kể cả đổi tên từ `.github/`) | không tự merge, `READY_FOR_MANUAL_MERGE` | "case 11" |
| 12 | PASS + CI xanh + Ready + ruleset | merge đúng HEAD | "case 12" |
| 13 | Draft hoặc `needs-human` dù có PASS cũ | không merge | "case 13" |
| 16 | Hai sự kiện review cho cùng PR/HEAD | không có hai merge; lần sau thấy PR đã merge thì `NONE`; concurrency theo repo, không hủy | "case 16" |
| 17 | Nhánh lỗi thời/HEAD đổi/CI mới/ruleset mất ngay trước merge | dừng, comment `AUTO_MERGE_STOPPED`, không retry/bypass | "case 17" (hai test) |
| 20 | Chưa có ruleset | từ chối (đỏ) | "case 20" |

## Hướng dẫn tạo GitHub App merge (chỉ chủ làm được)

Token mặc định `GITHUB_TOKEN` không đủ an toàn/đúng chủ đích để merge, nên dùng một App riêng, quyền tối thiểu.

1. GitHub → tổ chức `nexagnet` → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Tên ví dụ `nexagnet-merge-bot`; Homepage URL tùy ý; **bỏ chọn Webhook → Active**.
3. **Repository permissions**: *Contents: Read and write*, *Pull requests: Read and write*, *Metadata: Read-only* (tự có). Không cấp quyền khác.
4. **Where can this GitHub App be installed?**: *Only on this account*.
5. Tạo App, ghi lại **App ID**. Mục *Private keys* → **Generate a private key** (tải file `.pem`; giữ kín, không dán vào chat/repo).
6. **Install App** vào tổ chức: chọn *All repositories* (repo mới không phải cấu hình lại) hoặc chọn từng repo.
7. Tổ chức → **Settings → Secrets and variables → Actions → New organization secret**: `AUTONOMY_MERGE_APP_ID` (giá trị App ID) và `AUTONOMY_MERGE_APP_PRIVATE_KEY` (toàn bộ nội dung `.pem`). Phạm vi: các repo được chọn hoặc tất cả repo private. Xóa file `.pem` khỏi máy sau khi lưu nếu không cần.
8. Ruleset `main-protection` do bootstrap tạo **không có bypass**, nên App đi qua đúng luật như người (cần PR, check bắt buộc). Không thêm App vào danh sách bypass.

Kiểm tra: mở một PR mẫu không đụng `.github`, chuyển Ready, chờ `ci` và Reviewer xanh; bot phải merge đúng HEAD. PR chạm `.github` phải chỉ nhận comment `READY_FOR_MANUAL_MERGE`.

## Dùng cho repo mới

`scripts/bootstrap-repo.sh OWNER/REPO --apply --checks <job1,job2> [--sensitive-regex RE]` thêm caller này mặc định (tắt bằng `--no-merge-bot`) khi SHA ghim của `.github` đã có workflow. Xem `repo-bootstrap.md`.

## Nâng cấp / đã xử lý PR cũ

Bot này thay thế PR #12 (bản Autonomy cũ chồng trên #11, cần nhãn `autopilot:*`). Logic đã được viết lại từ `main`, đi theo đường Reviewer thường (không cần task contract/issue).
