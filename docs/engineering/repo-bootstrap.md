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

## Bot tự merge (`--with-merge-bot`, mặc định TẮT)

Bot merge nên nằm trong cùng lệnh khởi tạo để repo mới không phải cấu hình lại. Nhưng workflow bot merge (PR 4, lấy logic từ PR #12) **chưa được merge** ở `.github`, nên tùy chọn hiện **từ chối** (không ghi gì) cho tới khi `claude-autonomy.yml` tồn tại; khi PR bot merge vào, script được thêm mẫu caller và tùy chọn này chuyển thành bật mặc định.

Cấp GitHub App cho repo (chỉ chủ làm được, script không đặt secret): tạo một GitHub App merge riêng (Contents và Pull requests: write), cài vào các repo cần, và đặt secret `AUTONOMY_MERGE_APP_ID`, `AUTONOMY_MERGE_APP_PRIVATE_KEY`. Để repo mới khỏi cấu hình lại: cài App ở chế độ "All repositories" của tổ chức (hoặc thêm repo mới vào danh sách) và đặt hai secret ở **cấp tổ chức** với phạm vi các repo được chọn. Ruleset `main-protection` không có bypass, bot merge đi qua đúng luật như người.

## Ruleset cấp tổ chức (tách riêng)

Ruleset áp cho cả tổ chức thì không cần tạo từng repo. Kiểm bằng lệnh chỉ đọc (cần quyền owner của tổ chức, phiên Claude không đọc được):

```
scripts/bootstrap-repo.sh --check-org nexagnet
# hoặc trực tiếp:
gh api orgs/nexagnet --jq .plan.name
gh api orgs/nexagnet/rulesets
```

Nếu gói tổ chức hỗ trợ và đã có ruleset cấp tổ chức khớp repo mới, chạy bootstrap với `--skip-ruleset`. Chưa xác minh gói hiện tại của `nexagnet` có hỗ trợ hay không: phiên làm việc bị giới hạn ở endpoint của từng repo.

## Mỗi repo mới, chủ cần làm gì

1. Clone `nexagnet/.github`, đăng nhập `gh` bằng tài khoản admin, chạy: `scripts/bootstrap-repo.sh nexagnet/<repo> --apply --checks <job1,job2>` (thêm `--ignore-regex '\.meta$'` cho Unity). Lệnh tạo nhãn, đặt squash-only, mở PR bootstrap.
2. Trong PR bootstrap, thay các bước TODO của `ci.yml` bằng lệnh test/lint thật (hoặc đổi `--checks` cho khớp CI có sẵn), chờ `ci` xanh, merge tay (PR chạm `.github/**`).
3. Chạy lại đúng lệnh ở bước 1 để bật ruleset `main-protection`.
4. Xong. PR Ready đầu tiên sẽ được Reviewer tự chạy.

Secret `CLAUDE_CODE_OAUTH_TOKEN` được kế thừa từ tổ chức nên **không cần đặt từng repo** (chủ xác nhận; chưa tự kiểm được vì phiên không đọc được secret). Nếu secret tổ chức chỉ áp cho "repo được chọn" thì repo mới phải được thêm vào danh sách đó. Bước thử Reviewer thật trên PR mẫu sẽ xác nhận.

Việc còn lại chỉ chủ làm được: chạy `--apply` (phiên Claude không tự chạy lên repo thật), bảo đảm Actions cho phép dùng workflow reusable từ `nexagnet/.github`, và tạo GitHub App merge khi bật bot tự merge (chưa làm).

## Kiểm chứng

`tests/bootstrap-repo.test.cjs` chạy script với `gh` giả có trạng thái: dry-run không ghi, apply lần đầu, chạy lại không tạo trùng PR/nhánh/file, ruleset tạo mới và cập nhật, từ chối đầu vào sai trước khi ghi, `--skip-*`, `--check-org` chỉ đọc. `shellcheck` và `controlplane-ci` chạy các test này. **Chưa chạy `--apply` trên repo thật hay repo thử nào** (xem PR).
