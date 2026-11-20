# Khởi tạo repo mới bằng một lệnh

Mục tiêu: repo mới của tổ chức chỉ cần **một lệnh** để có nhãn, cài đặt merge, ruleset `main`, CI mẫu và caller Reviewer, không phải bấm tay trên GitHub.

```
scripts/bootstrap-repo.sh OWNER/REPO                     # chỉ in kế hoạch (dry-run, chỉ đọc)
scripts/bootstrap-repo.sh OWNER/REPO --apply             # thực hiện
scripts/bootstrap-repo.sh --check-org OWNER              # chỉ đọc: gói tổ chức, ruleset cấp tổ chức
```

Tùy chọn: `--checks a,b` (tên job CI bắt buộc, ít nhất 2; mặc định `test,lint`), `--authors login[,login]` (mặc định: tài khoản đang đăng nhập `gh`), `--ignore-regex '\.meta$'`, `--pin-sha <40 ký tự>` (mặc định: SHA hiện tại của `main` ở `nexagnet/.github`), `--skip-labels|--skip-settings|--skip-files|--skip-ruleset`.

Cần `gh` đăng nhập bằng tài khoản có **quyền admin repo**, cùng `jq`. Mặc định là dry-run; chỉ `--apply` mới ghi.

## Lệnh làm gì (theo thứ tự, chạy lại an toàn)

1. **Nhãn `needs-human`**: PR có nhãn này thì bot không tự merge (bot merge chưa có; xem kế hoạch PR 4). Không còn nhãn R0/R1/R2 cho PR thường.
2. **Cài đặt repo**: chỉ squash merge (tắt merge commit và rebase), tự xóa nhánh sau merge.
3. **PR bootstrap** (nhánh `claude/bootstrap-repo-ci`): thêm `ci.yml` mẫu và `nexagnet-claude-reviewer.yml` (ghim SHA của `.github`). File nào repo đã có thì **bỏ qua, không ghi đè**. `ci.yml` mẫu có hai job `test` và `lint` **cố ý đỏ** cho tới khi bạn thay bước TODO bằng lệnh thật, để tránh "CI xanh giả". PR chạm `.github/**` nên chủ repo duyệt và merge tay.
4. **Ruleset `main-protection`**: bắt buộc PR, chặn xóa và force-push, bắt buộc các check trong `--checks`, 0 approval, không bypass, chỉ cho squash. **Hoãn** nếu nhánh mặc định chưa có `.github/workflows/ci.yml` (bật sớm sẽ khóa chính PR bootstrap vì check chưa bao giờ chạy). Merge PR ở bước 3 rồi **chạy lại cùng lệnh** để bật.

Tên check trong ruleset là **tên job** (ví dụ `domain-tests`), không phải tên workflow `ci`. Đổi tên job trong `ci.yml` thì phải cập nhật `--checks` và chạy lại.

## Ruleset cấp tổ chức (tách riêng)

Ruleset áp cho cả tổ chức thì không cần tạo từng repo. Kiểm bằng lệnh chỉ đọc (cần quyền owner của tổ chức, phiên Claude không đọc được):

```
scripts/bootstrap-repo.sh --check-org nexagnet
# hoặc trực tiếp:
gh api orgs/nexagnet --jq .plan.name
gh api orgs/nexagnet/rulesets
```

Nếu gói tổ chức hỗ trợ và đã có ruleset cấp tổ chức khớp repo mới, chạy bootstrap với `--skip-ruleset`. Chưa xác minh gói hiện tại của `nexagnet` có hỗ trợ hay không: phiên làm việc bị giới hạn ở endpoint của từng repo.

## Việc chỉ chủ làm được

- Đăng nhập `gh` bằng tài khoản admin và chạy lệnh `--apply` (phiên Claude không tự chạy lên repo thật).
- Thêm secret `CLAUDE_CODE_OAUTH_TOKEN` vào repo mới (Settings > Secrets and variables > Actions), và bảo đảm Actions cho phép dùng workflow reusable từ `nexagnet/.github`.
- Tạo GitHub App merge và đặt secret khi bật bot tự merge (chưa làm).

## Kiểm chứng

`tests/bootstrap-repo.test.cjs` chạy script với `gh` giả có trạng thái: dry-run không ghi, apply lần đầu, chạy lại không tạo trùng PR/nhánh/file, ruleset tạo mới và cập nhật, từ chối đầu vào sai trước khi ghi, `--skip-*`, `--check-org` chỉ đọc. `shellcheck` và `controlplane-ci` chạy các test này. **Chưa chạy `--apply` trên repo thật hay repo thử nào** (xem PR).
