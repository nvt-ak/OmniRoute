# Plan: Reasoning Effort qua Combo OmniRoute (thinking-suffix)

> Ngày: 2026-07-22 · Branch code: `feature/thinking-suffix` · Server: sbu6 (54.179.64.158, PM2 `omniroute`)

## 1. Mục tiêu

Cho phép opencode gán **reasoning effort** (high) cho model Claude khi đi qua **combo OmniRoute** (`pool-main-opus`), route tới các model **adaptive-thinking-only** (Opus 4.8 / Sonnet 5 / Fable 5).

Cú pháp cuối cùng: **`pool-main-opus[high]`** (ngoặc vuông).

---

## 2. Bối cảnh & các phát hiện (đã verify)

### 2.1. opencode `variant` / `reasoningEffort` bị bug — KHÔNG gửi effort
- Log server: client gọi `pool-main-opus` nhưng body **không có** `reasoning_effort`.
- Known bug opencode: #25026, #21632 (variant parse đúng nhưng không apply runtime).
- => Không thể dựa vào `variant`/`reasoningEffort` phía opencode. Phải gắn effort ở OmniRoute.

### 2.2. Combo route tới model adaptive-only
- DB `~/.omniroute/storage.sqlite`, combo `pool-main-opus` (strategy priority):
  - `claude/claude-opus-4-8` → `adaptiveThinkingOnly: true`
  - `claude/claude-sonnet-5` → `adaptiveThinkingOnly: true`
- Model adaptive-only: reasoning điều khiển qua **`output_config.effort`**, KHÔNG dùng `thinking.budget_tokens` (gửi budget → HTTP 400).
- Ranh giới (src/shared/constants/modelSpecs.ts): Opus 4.7+/4.8, Fable 5, Sonnet 5 = adaptive-only. Opus 4.5/4.6, Sonnet 4.5 = manual budget OK.

### 2.3. Wire Anthropic KHÔNG forward `reasoning_effort`
- `@ai-sdk/anthropic` (Vercel AI SDK) Zod strip `reasoning_effort` (chỉ nhận `providerOptions.anthropic.thinking`).
- Log server: `/v1/messages` (anthropic wire) + reasoning_effort → **HTTP 400 "reasoning_effort: Extra inputs are not permitted"**.
- `@ai-sdk/openai-compatible` (`opencode-omniroute`, `9router`): forward `reasoningEffort` (camelCase) → body `reasoning_effort`. AN TOÀN.
- => Agent phải dùng provider `opencode-omniroute` (openai-compat wire).

### 2.4. Cú pháp suffix: `[]` không `()`
- OmniRoute combo name regex (`src/shared/validation/schemas/combo.ts:279`): `/^[a-zA-Z0-9_/.\-\[\] ]+$/`
  - Cho phép `[` `]`, **CHẶN** `(` `)`.
- opencode model id: KHÔNG có regex (verify vercel/ai + sst/opencode source) → chấp nhận cả `[]` và `()`.
- => **Phải dùng `[high]`** (ngoặc vuông). `()` không tạo được combo name.
- Dash `pool-main-opus-high` KHÔNG hoạt động (cơ chế parse chỉ nhận delimiter bracket).

---

## 3. Cơ chế thinking-suffix (commit `4bcd3ae12 add thinking-suffix`)

Two-point wiring (cho combo/pool fan-out):

- **Point 1** (`src/sse/handlers/chat.ts:~583`, TRƯỚC combo lookup):
  `splitThinkingSuffix("pool-main-opus[high]")` → strip `[high]`, lookup combo `pool-main-opus` (match), stash raw suffix vào `body._omnirouteThinkingSuffix`.
- **Point 2** (`open-sse/handlers/chatCore/thinkingSuffixVariant.ts`, mỗi target sau combo resolve):
  đọc marker, apply thinking config cho model đích, strip suffix khỏi model gửi upstream.

---

## 4. Code đã sửa (branch `feature/thinking-suffix`)

### 4.1. `open-sse/services/thinking/suffix.ts` — nhận `[]`
- `parseSuffix()` cũ: chỉ `(...)`.
- Sửa: ưu tiên `[...]`, fallback `(...)` (backward compat). Cả 2 delimiter 1 ký tự nên slice offset downstream không đổi.

### 4.2. `open-sse/handlers/chatCore/thinkingSuffixVariant.ts` — reconstruct dùng `[]` + FIX ROOT CAUSE
- Reconstruct `${baseModel}[${rawSuffix}]`.
- **FIX QUAN TRỌNG (apply format):**
  - Bug: Point 2 apply thinking ở TARGET format (Claude `thinking`/`output_config`) trên body vẫn ở SOURCE format (OpenAI). Sau đó `translateRequest(openai→claude)` (chatCore.ts:1934) rebuild body, KHÔNG carry các field Claude vừa set → effort mất → Claude `thinking_tokens: 0`.
  - Fix: khi `sourceFormat !== targetFormat` (sẽ translate downstream), apply ở **SOURCE format** → set `reasoning_effort` (OpenAI field) → translator openai→claude tự convert thành `output_config.effort` đúng cho adaptive model.
  - `applyFormat = srcFmt !== tgtFmt ? srcFmt : tgtFmt`

### 4.3. Tests
- `tests/unit/thinking-suffix-parse.test.ts`: +6 case `[]`.
- `tests/unit/thinking-suffix-registry.test.ts`: +test `splitThinkingSuffix` với `[]`.
- Kết quả: **38/38 pass**.

### 4.4. Verify end-to-end (local)
```
pool-main-opus[high]
  → Point 2: body.reasoning_effort = "high"
  → translateRequest(openai→claude):
       thinking = {"type":"adaptive"}
       output_config = {"effort":"high"}   ✅
       reasoning_effort = undefined (đã convert)
```

---

## 5. Config đã sửa (2 file, local)

### 5.1. `~/.config/opencode/opencode.json`
- Thêm model key: `pool-main-opus[high]`, `pool-subagent-sonnet[high]` trong `provider.opencode-omniroute.models`.
- 8 agent chính → `opencode-omniroute/pool-main-opus[high]` (giữ nguyên `variant`).
- Backup: `.backup-suffix-20260722-121420`

### 5.2. `~/.config/opencode/oh-my-openagent.json`
- 4 agent (sisyphus, oracle, prometheus, momus) + 4 category (artistry, deep, ultrabrain, visual-engineering) → `pool-main-opus[high]`.
- Giữ `reasoningEffort` field.
- Backup: `.backup-suffix-<timestamp>`

Chỉ dùng `[high]` (không `[xhigh]` — tiết kiệm cost). Subagent sonnet giữ nguyên (không effort).

---

## 6. Server config đã đổi (debug logging)

- `~/.omniroute/.env`: `CALL_LOG_PIPELINE_MAX_SIZE_KB=18192` (tăng từ default 512KB để pipeline log không bị drop bởi payload lớn 270 tools / 260KB).
  - Backup: `.env.backup-20260722-035612`
- Dashboard: toggle "Capture pipeline payloads" (Logs page) đã BẬT — để đọc body thật per-stage.
- **Nhớ tắt / hạ lại sau khi debug xong** (tốn disk).

---

## 7. ⚠️ BUG CÒN LẠI (chưa fix) — nghiêm trọng hơn

**Phát hiện mới:** Claude-format passthrough (`/v1/messages`, source=target=claude) — client TỰ gửi `thinking={type:"adaptive"}` (không qua suffix):
- clientRawRequest.thinking = `{"type":"adaptive"}` ✅
- **providerRequest.thinking = null, output_config = null** ❌ (bị strip)
- providerResponse: `thinking_tokens: 0`

=> Có bước strip `thinking={type:adaptive}` ở passthrough path (opus-4-8 adaptive), KHÔNG liên quan suffix. Ảnh hưởng cả khi client gửi thinking trực tiếp.

**Đã loại trừ:** `normalizeClaudeAdaptiveThinking` (no-op với adaptive không budget), `normalizeThinkingForModel` (chỉ xóa type=disabled), `fitThinkingToMaxTokens` (không chạy passthrough).

**Nghi ngờ:** `redactPassthroughThinkingSignatures` / `sanitizeClaudePassthroughThinkingBlocks` (chatCore.ts:1779,1788), hoặc executor claude allowlist field, hoặc build upstream body drop thinking.

**TODO:** trace điểm strip cuối cùng áp cho MỌI path (đang chờ explore `bg_b8eca355`). Fix suffix (mục 4.2) có thể vẫn bị strip ở bước này → cần verify sau deploy.

---

## 8. TODO / Thứ tự triển khai

- [ ] **Điều tra bug mục 7** (điểm strip thinking chung ở passthrough / build upstream). BLOCKER — nếu không fix, effort vẫn bị xóa dù suffix set đúng.
- [ ] `npm run typecheck:core` cho file đã sửa.
- [ ] Build + deploy branch `feature/thinking-suffix` lên server (pm2 restart).
- [ ] Restart opencode (nạp 2 config mới).
- [ ] Verify log: `Thinking suffix: [high] → claude-opus-4-8 (apply=openai) signal="high"` + providerRequest có `output_config.effort=high` + response `thinking_tokens > 0`.
- [ ] Dọn: xóa combo thừa `pool-main-opus[high]`, `pool-main-opus-high` trên dashboard (Point 1 strip suffix nên chỉ cần combo gốc `pool-main-opus`). Fix `sisyphus-junior` (đang trỏ `pool-subagent-opus` chưa khai báo).
- [ ] Hạ `CALL_LOG_PIPELINE_MAX_SIZE_KB` + tắt pipeline capture sau khi verify xong.

---

## 9. Ghi chú về response thinking (insight của user)
- Claude OAuth trả thinking trong field **encrypted** (CLIProxyAPI cũng vậy) — đây là chuyện **RESPONSE**, chấp nhận được.
- Bug đang fix là chuyện **REQUEST** (effort không được gửi đi) — khác hoàn toàn. `thinking_tokens: 0` chứng minh Claude không reasoning vì request thiếu effort.

---

## 10. ⚠️ PHÁT HIỆN QUYẾT ĐỊNH (2026-07-22, verify bằng call log thật + inspect server)

### 10.1. Server KHÔNG chạy PM2 — chạy `omniroute` npm global
- Process thật: `node ~/.nvm/versions/node/v24.18.0/bin/omniroute` (start 05:23), KHÔNG có `pm2`.
- Package cài: `~/.nvm/versions/node/v24.18.0/lib/node_modules/omniroute` **v3.8.49** (khớp local).
- => Deploy = cập nhật package global này (không phải `pm2 restart`, không phải rsync `dist/` vào `/usr/lib/...`). Restart = kill process + `omniroute` lại.

### 10.2. Thinking-Budget mode = PASSTHROUGH (KHÔNG phải AUTO)
- `settings` table TRỐNG (không có row `thinkingBudget`), không env override → default `PASSTHROUGH` (`thinkingBudget.ts:53`).
- => Nhánh strip `base.ts:905 (tbMode === AUTO)` **KHÔNG chạy** trên production. Fix mirror-guard cho AUTO (đã làm local) chỉ là **defensive**, KHÔNG phải nguyên nhân bug production.

### 10.3. Server chạy build CŨ/PARTIAL của thinking-suffix
- `suffix.ts` bracket `[...]`: ✅ CÓ trên server.
- `thinkingSuffixVariant.ts` **applyFormat fix (`srcFmt !== tgtFmt`)**: ❌ **KHÔNG có** trên server (chỉ có const `THINKING_SUFFIX_MARKER`). Local có (commit `425793f51`, branch `fix/cache`).
- `base.ts` AUTO guard: ❌ không có (đang là strip vô điều kiện cũ).
- => Server = build thiếu fix cốt lõi. Commit `425793f51` local-only, CHƯA deploy.

### 10.4. Call log THẬT (`2026-07-22T06-44-30...json`) — bằng chứng nguồn gốc
- `clientRawRequest.model = "pool-main-opus[high]"` ✅ (suffix TỚI server đúng).
- `clientRawRequest.body` keys = `[model, max_tokens, messages, tools, tool_choice, stream, stream_options]` → **KHÔNG có `reasoning_effort`** (opencode openai-compatible KHÔNG gửi effort trong body — đúng như mục 2.1).
- `providerRequest.body` keys (gửi lên Anthropic) = `[model, messages, system, tools, tool_choice, metadata, max_tokens, stream]` → **KHÔNG có `thinking`, KHÔNG có `output_config`**.
- `summary.tokens.reasoning = null`. `_omnirouteThinkingSuffix` marker **VẮNG MẶT** trong request → suffix mechanism (Point 1/Point 2) KHÔNG chạy trên request này (do build cũ thiếu applyFormat, hoặc marker chưa stash).
- KẾT LUẬN: KHÔNG có "downstream strip" nào cả ở passthrough. Vấn đề là **server-side inject KHÔNG chạy** vì build thiếu fix. Suffix `[high]` được parse (bracket support có) nhưng effort không được inject đúng format vào body Claude.

### 10.5. Việc cần làm (SỬA LẠI so với mục 8)
- [ ] Chờ Oracle `bg_eab8b5d5`: xác nhận VỚI applyFormat fix deployed, path passthrough + openai-format có inject `output_config.effort` đúng không, hay còn gap (VD: Point 2 chỉ chạy khi có marker; marker set ở đâu; passthrough có gọi Point 2 không).
- [ ] Commit `base.ts` mirror-guard + tests (defensive, giữ lại).
- [ ] **Build lại** package (`npm run build`) với ĐẦY ĐỦ: applyFormat fix (đã commit) + base.ts guard (mới).
- [ ] **Deploy đúng cách**: cập nhật `omniroute` global trên server (npm i -g từ build, hoặc copy `open-sse`/`dist`/`.build` vào `~/.nvm/.../lib/node_modules/omniroute/`), rồi kill + restart process `omniroute`. KHÔNG dùng pm2.
- [ ] Verify lại bằng call log mới: `providerRequest` có `output_config.effort=high` + `thinking:{type:adaptive}` + `summary.tokens.reasoning > 0`.

---

## 11. ⚠️ PHÁT HIỆN: CÓ 2 BUG RIÊNG BIỆT (2026-07-22, verify bằng call log thật)

Ban đầu tưởng 1 bug. Thực tế là **2 bug độc lập**, cần 2 fix khác nhau:

### BUG #1 — openai → claude (opencode dùng openai-compatible)
- `sourceFormat: openai`, `targetFormat: claude`. Có translator.
- Nguyên nhân: Point-2 (`thinkingSuffixVariant.ts`) apply SAI format (claude thay vì openai) TRƯỚC translator → translator đi nhánh A (`if body.thinking`) thay vì nhánh B (`else if body.reasoning_effort`) → thiếu `output_config.effort`.
- **Fix = `applyFormat`** (working tree, CHƯA commit — KHÔNG có trong `425793`). Verify xong qua source+log.
- Log bản cũ: `Thinking suffix: [high] → claude-opus-4-8 (claude) ...`. Bản mới sẽ là `(apply=openai)`.
- Bằng chứng translator: `open-sse/translator/request/openai-to-claude.ts:175` (nhánh A) vs `:181` (nhánh B, set cả thinking+output_config cho adaptiveThinkingOnly).

### BUG #2 — claude → claude passthrough (claude-cli gửi thẳng /v1/messages) — MỚI PHÁT HIỆN
- Call log thật `1784704946117-f1ccd1`: `path:/v1/messages`, `sourceFormat:claude`, `targetFormat:claude`.
- Header: `x-app:cli` + `user-agent:claude-cli/2.1.217` → **`isClaudeCodeClient=TRUE`**.
- Client gửi SẴN ĐẦY ĐỦ: `thinking:{type:adaptive}` + `output_config:{effort:high}` + `context_management`.
- `providerRequest`: **CẢ 3 = null** (thinking, output_config, context_management đều biến mất cùng lúc).
- Mode = PASSTHROUGH → nhánh AUTO strip (base.ts:905) KHÔNG chạy. Nhánh 909 (`both undefined`) FALSE vì client set sẵn → no-op. → điểm strip nằm NGOÀI khối cloak base.ts (nghi: allowlist rebuild body claude-native).
- **Fix `applyFormat` KHÔNG giải quyết bug #2** (bug #2 không qua translator).
- Đang trace: Oracle `bg_f7685575` (session `ses_07747eb6fffe5Xa6UAfflu6BvB`).
- Dấu hiệu "cả 3 biến mất cùng lúc" → nghi allowlist-based body rebuild cho upstream claude-native, KHÔNG phải thinking normalizer.

### Thứ tự deploy đề xuất
1. Deploy fix #1 (`applyFormat`) — giải quyết opencode (main use case).
2. Chờ Oracle bg_f7685575 → fix #2 (passthrough claude-cli).
3. Cả 2 fix cùng lúc rồi restart + verify từng path.

---

## 12. 🎯 ROOT CAUSE THẬT của BUG #1 (2026-07-22, verify bằng node chạy trên server)

`applyFormat` đã deploy + hoạt động (log `(apply=openai) signal="high"`, `requestBody.reasoning_effort="high"` set đúng). NHƯNG providerRequest VẪN rỗng thinking → có bug SÂU HƠN:

### Bug: model prefix `claude/` phá `isAdaptiveThinkingOnly` trong translator
- `chatCore.ts:1936` gọi `translateRequest(..., model, ...)` với `model = "claude/claude-opus-4-8"` (CÓ prefix, từ combo target).
- Prefix chỉ được strip ở `chatCore.ts:2056-2068` (`finalModelToUpstream`) — **SAU** translateRequest.
- Trong translator `openai-to-claude.ts:190`: `isAdaptiveThinkingOnly(model)`:
  - Verify chạy node THẬT trên server:
    - `isAdaptiveThinkingOnly("claude-opus-4-8")` = **true**
    - `isAdaptiveThinkingOnly("claude/claude-opus-4-8")` = **FALSE** ← BUG
    - `isAdaptiveThinkingOnly("claude-opus-4-8[high]")` = true
  - Vì `getCanonicalModelSpecId` prefix rule là `lower.startsWith(key)`: `"claude/claude-opus-4-8"`.startsWith(`"claude-opus-4-8"`) = false → null → adaptiveOnly=false.
- → translator KHÔNG vào nhánh adaptive (181-205), rơi vào `else` budget map (high→131072) → set `thinking:{type:enabled, budget_tokens:131072}`.
- → model adaptive-only từ chối `enabled` → `normalizeClaudeAdaptiveThinking` (2081) collapse/xóa → providerRequest RỖNG → `thinking_tokens:0`.

### Fix candidates (chờ Oracle bg_bb052d3d chọn):
- A: sửa `getCanonicalModelSpecId` — strip `provider/` prefix khi lookup fail. (rủi ro: model id chứa `/` hợp lệ như vertex/openrouter `vendor/model`)
- B: strip prefix trước khi gọi translateRequest (chatCore:1936).
- C: đọc `getModelSpec` với bare model trong translator.
- 30 call-site dùng getModelSpec/isAdaptiveThinkingOnly → phải chọn cẩn thận.

### Lưu ý: applyFormat CÓ CÒN CẦN không?
- applyFormat set `reasoning_effort` đúng (openai-shape) → translator CÓ nhận. Nhưng translator xử lý sai vì prefix. Sau khi fix prefix, applyFormat vẫn cần (để reasoning_effort có mặt cho translator convert). → giữ cả 2 fix.
