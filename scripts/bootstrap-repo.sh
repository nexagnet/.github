#!/usr/bin/env bash
# Khởi tạo một repo mới theo chuẩn Nexagnet bằng MỘT lệnh. Idempotent: chạy lại an toàn.
#
#   scripts/bootstrap-repo.sh OWNER/REPO [tùy chọn]          # chỉ IN kế hoạch (dry-run, chỉ đọc)
#   scripts/bootstrap-repo.sh OWNER/REPO --apply [tùy chọn]  # thực hiện
#   scripts/bootstrap-repo.sh --check-org OWNER              # chỉ đọc: gói tổ chức và ruleset cấp tổ chức
#   --no-merge-bot    không thêm caller bot merge (mặc định BẬT khi .github đã có claude-autonomy.yml)
#   --sensitive-regex RE  đường dẫn nhạy cảm riêng của dự án: PR chạm vào chỉ nhận READY_FOR_MANUAL_MERGE
#
# Việc làm (theo thứ tự):
#   1. Nhãn `needs-human` (PR có nhãn này thì bot KHÔNG tự merge).
#   2. Cài đặt repo: chỉ squash merge, tự xóa nhánh sau merge.
#   3. PR thêm ci.yml mẫu (cố ý đỏ cho tới khi bạn điền lệnh thật) và caller Reviewer
#      (file nào repo đã có thì bỏ qua, không ghi đè).
#   4. Ruleset `main-protection` (bắt buộc PR, chặn force-push/xóa, bắt buộc các check, 0 approval,
#      không bypass): chỉ tạo khi nhánh mặc định ĐÃ có .github/workflows/ci.yml. Nếu chưa, in
#      "hoãn" và bạn chạy lại sau khi merge PR ở bước 3 (tránh khóa chính PR bootstrap).
#
# Cần: gh đã đăng nhập bằng tài khoản có quyền admin repo, jq, base64.
# Không bao giờ in/đọc secret. Không đụng repo nào ngoài OWNER/REPO được chỉ định.
set -euo pipefail

TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../templates/repo-bootstrap" && pwd)"
CENTRAL_REPO="nexagnet/.github"
BRANCH_NAME="claude/bootstrap-repo-ci"
RULESET_NAME="main-protection"
LABEL_NAME="needs-human"

die() { echo "LỖI: $*" >&2; exit 2; }
usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# ---- check-org (chỉ đọc) ----------------------------------------------------------------
if [[ "${1:-}" == "--check-org" ]]; then
  org="${2:-}"; [[ "$org" =~ ^[A-Za-z0-9-]+$ ]] || die "dùng: --check-org OWNER"
  echo "== Gói tổ chức (cần quyền owner của tổ chức)"
  if plan="$(gh api "orgs/$org" --jq '.plan.name // "không đọc được"' 2>/dev/null)"; then
    echo "plan: $plan"
  else
    echo "Không đọc được thông tin tổ chức (thiếu quyền hoặc API bị chặn)."
  fi
  echo "== Ruleset cấp tổ chức"
  if out="$(gh api "orgs/$org/rulesets" --jq '[.[] | {id, name, enforcement}]' 2>&1)"; then
    echo "$out"
    echo "Nếu đã có ruleset cấp tổ chức áp cho repo mới, chạy bootstrap với --skip-ruleset."
  else
    echo "Không đọc được ruleset tổ chức: $(echo "$out" | head -c 200)"
    echo "Có thể gói hiện tại không hỗ trợ ruleset cấp tổ chức, hoặc thiếu quyền. Dùng ruleset từng repo (mặc định)."
  fi
  exit 0
fi

# ---- tham số ------------------------------------------------------------------------------
repo="${1:-}"; [[ "$repo" == "-h" || "$repo" == "--help" ]] && usage 0
[[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || usage 2
shift
apply=0 skip_labels=0 skip_settings=0 skip_files=0 skip_ruleset=0 with_merge_bot=1 merge_bot_explicit=0 sensitive_regex=""
checks="test,lint" authors="" ignore_regex="" pin_sha=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) apply=1 ;;
    --skip-labels) skip_labels=1 ;;
    --skip-settings) skip_settings=1 ;;
    --skip-files) skip_files=1 ;;
    --skip-ruleset) skip_ruleset=1 ;;
    --with-merge-bot) with_merge_bot=1; merge_bot_explicit=1 ;;
    --no-merge-bot) with_merge_bot=0 ;;
    --sensitive-regex) sensitive_regex="${2:?}"; shift ;;
    --checks) checks="${2:?}"; shift ;;
    --authors) authors="${2:?}"; shift ;;
    --ignore-regex) ignore_regex="${2:?}"; shift ;;
    --pin-sha) pin_sha="${2:?}"; shift ;;
    -h|--help) usage 0 ;;
    *) die "tùy chọn lạ: $1" ;;
  esac
  shift
done
[[ "$checks" =~ ^[a-zA-Z][a-zA-Z0-9_-]{1,63}(,[a-zA-Z][a-zA-Z0-9_-]{1,63})+$ ]] \
  || die "--checks cần ít nhất 2 tên job hợp lệ, cách nhau bằng dấu phẩy (Reviewer yêu cầu)"
[[ -z "$ignore_regex" || ( ${#ignore_regex} -le 200 && "$ignore_regex" != *"'"* && "$ignore_regex" != *"#"* ) ]] || die "--ignore-regex quá dài hoặc chứa dấu ' hay #"
[[ -z "$pin_sha" || "$pin_sha" =~ ^[0-9a-f]{40}$ ]] || die "--pin-sha phải là SHA 40 ký tự"
[[ -z "$authors" || "$authors" =~ ^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$ ]] || die "--authors không hợp lệ"

[[ -z "$sensitive_regex" || ( ${#sensitive_regex} -le 200 && "$sensitive_regex" != *"'"* && "$sensitive_regex" != *"#"* ) ]] \
  || die "--sensitive-regex quá dài hoặc chứa dấu ' hay #"

# Đọc trước (chỉ đọc) để mọi lỗi cấu hình xảy ra TRƯỚC khi ghi bất cứ gì.
if [[ $skip_files -eq 0 ]]; then
  [[ -n "$authors" ]] || authors="$(gh api user --jq .login)"
  [[ "$authors" =~ ^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$ ]] || die "--authors không hợp lệ"
  if [[ -z "$pin_sha" ]]; then
    pin_sha="$(gh api "repos/$CENTRAL_REPO/commits/$(gh api "repos/$CENTRAL_REPO" --jq .default_branch)" --jq .sha)"
  fi
  [[ "$pin_sha" =~ ^[0-9a-f]{40}$ ]] || die "không xác định được SHA của $CENTRAL_REPO"
  # Bot merge chỉ thêm khi SHA được ghim đã chứa workflow bot merge (nếu không, caller sẽ hỏng).
  if [[ $with_merge_bot -eq 1 ]] \
     && ! gh api "repos/$CENTRAL_REPO/contents/.github/workflows/claude-autonomy.yml?ref=$pin_sha" >/dev/null 2>&1; then
    [[ $merge_bot_explicit -eq 0 ]] \
      || die "--with-merge-bot: $CENTRAL_REPO@$pin_sha chưa có claude-autonomy.yml. Không có gì bị thay đổi."
    echo "Lưu ý: $CENTRAL_REPO@$pin_sha chưa có claude-autonomy.yml nên bỏ qua caller bot merge."
    with_merge_bot=0
  fi
fi

mode="DRY-RUN (chỉ đọc; thêm --apply để thực hiện)"; [[ $apply -eq 1 ]] && mode="APPLY"
echo "Repo: $repo | Chế độ: $mode"

# GET luôn chạy; ghi chỉ chạy khi --apply.
get() { gh api "$@"; }
write() { # write <mô tả> <gh api args...>
  local desc="$1"; shift
  if [[ $apply -eq 1 ]]; then gh api "$@" >/dev/null; echo "  ĐÃ LÀM: $desc"; else echo "  SẼ LÀM: $desc"; fi
}

default_branch="$(get "repos/$repo" --jq .default_branch)" || die "không đọc được repo $repo (tên đúng? có quyền?)"
echo "Nhánh mặc định: $default_branch"

# ---- 1. nhãn -----------------------------------------------------------------------------
if [[ $skip_labels -eq 0 ]]; then
  echo "[1/4] Nhãn $LABEL_NAME"
  desc_label="PR cần người xem: bot không tự merge"
  if get "repos/$repo/labels/$LABEL_NAME" >/dev/null 2>&1; then
    write "cập nhật nhãn $LABEL_NAME" -X PATCH "repos/$repo/labels/$LABEL_NAME" \
      -f color=d93f0b -f description="$desc_label"
  else
    write "tạo nhãn $LABEL_NAME" -X POST "repos/$repo/labels" \
      -f name="$LABEL_NAME" -f color=d93f0b -f description="$desc_label"
  fi
fi

# ---- 2. cài đặt repo ---------------------------------------------------------------------
if [[ $skip_settings -eq 0 ]]; then
  echo "[2/4] Cài đặt: chỉ squash, tự xóa nhánh sau merge"
  write "đặt allow_squash_merge=true, merge commit/rebase tắt, delete_branch_on_merge=true" \
    -X PATCH "repos/$repo" \
    -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
    -F delete_branch_on_merge=true
fi

# ---- 3. file mẫu qua PR ------------------------------------------------------------------
default_has_ci=0
if get "repos/$repo/contents/.github/workflows/ci.yml?ref=$default_branch" >/dev/null 2>&1; then default_has_ci=1; fi

if [[ $skip_files -eq 0 ]]; then
  echo "[3/4] PR thêm ci.yml mẫu và caller Reviewer"
  echo "  Ghim $CENTRAL_REPO@$pin_sha ; tác giả tin cậy: $authors ; check bắt buộc: $checks ; bot merge: $([[ $with_merge_bot -eq 1 ]] && echo bật || echo tắt)"

  render() { # render <template> -> stdout
    sed -e "s#__PIN_SHA__#$pin_sha#g" -e "s#__CHECKS_CSV__#$checks#g" \
        -e "s#__AUTHORS_CSV__#$authors#g" -e "s#__IGNORE_REGEX__#${ignore_regex//\\/\\\\}#g" \
        -e "s#__SENSITIVE_REGEX__#${sensitive_regex//\\/\\\\}#g" "$1"
  }
  declare -A want=( [".github/workflows/ci.yml"]="$TEMPLATE_DIR/ci.yml"
                    [".github/workflows/nexagnet-claude-reviewer.yml"]="$TEMPLATE_DIR/nexagnet-claude-reviewer.yml"
                    [".github/workflows/nexagnet-claude-autonomy.yml"]="$TEMPLATE_DIR/nexagnet-claude-autonomy.yml" )
  wanted=(".github/workflows/ci.yml" ".github/workflows/nexagnet-claude-reviewer.yml")
  [[ $with_merge_bot -eq 1 ]] && wanted+=(".github/workflows/nexagnet-claude-autonomy.yml")
  missing=()
  for path in "${wanted[@]}"; do
    if get "repos/$repo/contents/$path?ref=$default_branch" >/dev/null 2>&1; then
      echo "  Bỏ qua (đã có): $path"
    else
      missing+=("$path")
    fi
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "  Không có file nào cần thêm."
  elif existing_pr="$(get "repos/$repo/pulls?state=open&head=${repo%%/*}:$BRANCH_NAME" --jq '.[0].number // empty')" \
       && [[ -n "$existing_pr" ]]; then
    echo "  Đã có PR bootstrap đang mở: #$existing_pr (không tạo thêm)."
  else
    base_sha="$(get "repos/$repo/git/ref/heads/$default_branch" --jq .object.sha)"
    if [[ $apply -eq 1 ]]; then
      get "repos/$repo/git/ref/heads/$BRANCH_NAME" >/dev/null 2>&1 \
        || gh api -X POST "repos/$repo/git/refs" -f ref="refs/heads/$BRANCH_NAME" -f sha="$base_sha" >/dev/null
    else
      echo "  SẼ LÀM: tạo nhánh $BRANCH_NAME từ $base_sha"
    fi
    for path in "${missing[@]}"; do
      content="$(render "${want[$path]}" | base64 -w0)"
      if [[ $apply -eq 1 ]]; then
        jq -n --arg m "ci: thêm $(basename "$path") (bootstrap)" --arg c "$content" --arg b "$BRANCH_NAME" \
          '{message:$m, content:$c, branch:$b}' | gh api -X PUT "repos/$repo/contents/$path" --input - >/dev/null
        echo "  ĐÃ LÀM: thêm $path vào nhánh $BRANCH_NAME"
      else
        echo "  SẼ LÀM: thêm $path vào nhánh $BRANCH_NAME"
      fi
    done
    body=$'Thêm CI mẫu và caller Reviewer dùng chung (bootstrap).\n\n- `ci.yml` mẫu **cố ý đỏ**: thay các bước TODO bằng lệnh build/test/lint thật rồi mới merge.\n- Caller Reviewer ghim `'"$CENTRAL_REPO@$pin_sha"$'`; cần secret `CLAUDE_CODE_OAUTH_TOKEN` của repo.\n- Nếu có `nexagnet-claude-autonomy.yml`: bot merge cần secret `AUTONOMY_MERGE_APP_ID`/`AUTONOMY_MERGE_APP_PRIVATE_KEY` (GitHub App); thiếu thì bot không merge được.\n- Sau khi merge, chạy lại `scripts/bootstrap-repo.sh '"$repo"$' --apply` để bật ruleset `main-protection`.\n\nPR chạm `.github/**` nên chủ repo duyệt và merge tay.'
    if [[ $apply -eq 1 ]]; then
      jq -n --arg t "ci: bootstrap CI mẫu và caller Reviewer" --arg h "$BRANCH_NAME" --arg b "$default_branch" --arg body "$body" \
        '{title:$t, head:$h, base:$b, body:$body}' | gh api -X POST "repos/$repo/pulls" --input - --jq '"  ĐÃ LÀM: mở PR " + .html_url'
    else
      echo "  SẼ LÀM: mở PR bootstrap vào $default_branch"
    fi
  fi
fi

# ---- 4. ruleset main ---------------------------------------------------------------------
if [[ $skip_ruleset -eq 0 ]]; then
  echo "[4/4] Ruleset $RULESET_NAME"
  if [[ $default_has_ci -eq 0 ]]; then
    echo "  HOÃN: nhánh $default_branch chưa có .github/workflows/ci.yml. Bật ruleset bây giờ sẽ khóa merge"
    echo "  (check bắt buộc chưa bao giờ chạy). Merge PR ở bước 3 rồi chạy lại lệnh này."
  else
    ruleset="$(jq -n --arg name "$RULESET_NAME" --arg checks "$checks" '{
      name:$name, target:"branch", enforcement:"active",
      conditions:{ref_name:{include:["~DEFAULT_BRANCH"], exclude:[]}},
      bypass_actors:[],
      rules:[
        {type:"deletion"},
        {type:"non_fast_forward"},
        {type:"pull_request", parameters:{
          required_approving_review_count:0, dismiss_stale_reviews_on_push:false,
          require_code_owner_review:false, require_last_push_approval:false,
          required_review_thread_resolution:false, allowed_merge_methods:["squash"]}},
        {type:"required_status_checks", parameters:{
          strict_required_status_checks_policy:false,
          required_status_checks:($checks | split(",") | map({context:.}))}}
      ]}')"
    existing_id="$(get "repos/$repo/rulesets" --jq ".[] | select(.name==\"$RULESET_NAME\") | .id" | head -1)"
    if [[ -n "$existing_id" ]]; then
      if [[ $apply -eq 1 ]]; then
        gh api -X PUT "repos/$repo/rulesets/$existing_id" --input - <<< "$ruleset" >/dev/null
        echo "  ĐÃ LÀM: cập nhật ruleset $RULESET_NAME (#$existing_id)"
      else echo "  SẼ LÀM: cập nhật ruleset $RULESET_NAME (#$existing_id)"; fi
    else
      if [[ $apply -eq 1 ]]; then
        gh api -X POST "repos/$repo/rulesets" --input - <<< "$ruleset" >/dev/null
        echo "  ĐÃ LÀM: tạo ruleset $RULESET_NAME"
      else echo "  SẼ LÀM: tạo ruleset $RULESET_NAME (check bắt buộc: $checks, 0 approval, không bypass)"; fi
    fi
  fi
fi
echo "Xong ($mode)."
