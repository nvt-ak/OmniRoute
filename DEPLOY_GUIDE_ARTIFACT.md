# 🎯 Deploy OmniRoute — build trên GitHub Actions, server chỉ tải + chạy

> Server yếu KHÔNG build gì. GitHub Actions build npm tarball từ nhánh `fix/cache`
> (Linux x64, Node 24 — khớp server). Server tải `.tgz` → `npm i -g` → PM2 + Caddy.
>
> **Môi trường đã xác nhận**: EC2 x86_64 · Node v24.18.0 · Ubuntu 22.04 · 18G trống ·
> repo public · domain `sbu6-omniroute.dev.kaopiz.com` (Route53 → EIP).

---

## PHẦN A — Build artifact trên GitHub Actions (manual)

1. Vào repo GitHub → tab **Actions**.
2. Chọn workflow **"Build npm artifact (fork)"** (bên trái).
3. Bấm **Run workflow**:
   - **ref**: `fix/cache` (mặc định)
   - **Clean build**: để TẮT (chỉ bật khi nghi cache lỗi)
   - → **Run workflow**.
4. Đợi build xong (~5-10 phút, nhanh hơn nhờ cache). Workflow tự gắn file vào
   **Release** tag `build-latest` → có link download **public** cố định:

```
https://github.com/phonex34/OmniRoute/releases/download/build-latest/omniroute.tgz
```

> - Workflow chỉ chạy **manual** (không tự chạy khi push).
> - Link trên **không đổi** qua mỗi lần build (rolling release) → luôn trỏ bản mới nhất.
> - Nếu build lỗi nghi do cache → chạy lại, **tick "Clean build"** để build sạch.

---

## PHẦN B — Chuẩn bị server (1 lần)

Node 24 đã có sẵn (v24.18.0). Chỉ cần PM2 + vài tool:

```bash
sudo apt update && sudo apt install -y curl wget

# PM2 (dùng node 24 đang có)
npm install -g pm2

# Tạo data dir + .env (tách khỏi code, ở ~/.omniroute)
mkdir -p ~/.omniroute
curl -fsSL https://raw.githubusercontent.com/phonex34/OmniRoute/fix/cache/.env.example \
  -o ~/.omniroute/.env

cd ~/.omniroute
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48)|" .env
sed -i "s|^API_KEY_SECRET=.*|API_KEY_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^STORAGE_ENCRYPTION_KEY=.*|STORAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env
sed -i "s|^INITIAL_PASSWORD=.*|INITIAL_PASSWORD=$(openssl rand -base64 18)|" .env
grep INITIAL_PASSWORD .env   # ⚠️ LƯU LẠI mật khẩu admin
cd ~
```

> `.env` ở `~/.omniroute/` → không bị đụng khi update. `DATA_DIR` để trống → app tự
> dùng `~/.omniroute` cho cả `.env` lẫn SQLite DB.

---

## PHẦN C — Tải artifact về server (wget, KHÔNG cần token/gh)

Repo public + workflow gắn vào Release → tải thẳng bằng `wget`:

```bash
mkdir -p ~/omniroute-dl && cd ~/omniroute-dl
wget -O omniroute.tgz \
  https://github.com/phonex34/OmniRoute/releases/download/build-latest/omniroute.tgz
```

> Link cố định, không đổi qua mỗi lần build. Không cần login, không cần `gh` CLI.

---

## PHẦN D — Cài đặt từ tarball

```bash
cd ~/omniroute-dl
# Cài global (giống official npm, nhưng từ nhánh fix/cache của bạn)
npm install -g ./omniroute.tgz

# Verify
omniroute --version
```

> `npm i -g` sẽ chạy postinstall (warm-up native SQLite prebuilt cho Linux x64).
> Native binary đã được Actions build sẵn cho Linux trong tarball → không compile.

---

## PHẦN E — Chạy 24/7 với PM2

```bash
# Start qua bin `omniroute` (tự load .env ở ~/.omniroute, resolve dist/ đúng)
pm2 start omniroute --name omniroute

# Auto-start khi reboot
pm2 save
pm2 startup   # copy & chạy lại dòng `sudo ...` nó in ra

pm2 logs omniroute   # kiểm tra khởi động OK, bind :20128
```

Test: `curl -I http://localhost:20128` → có response là OK.

> Heap ceiling (nếu cần tăng cho fusion combo nặng):
>
> ```bash
> pm2 delete omniroute
> OMNIROUTE_MEMORY_MB=1024 pm2 start omniroute --name omniroute
> pm2 save
> ```

---

## PHẦN F — HTTPS + domain qua Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
sbu6-omniroute.dev.kaopiz.com {
    reverse_proxy localhost:20128
}
EOF
sudo systemctl restart caddy

# Firewall: mở 80,443. AWS Security Group cũng phải mở inbound 80 + 443.
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable

curl -I https://sbu6-omniroute.dev.kaopiz.com   # → 200 / redirect
```

Mở: **https://sbu6-omniroute.dev.kaopiz.com** → login bằng `INITIAL_PASSWORD`.

---

## PHẦN G — (Khuyến nghị) Bật API key protection

```bash
echo "REQUIRE_API_KEY=true" >> ~/.omniroute/.env
pm2 restart omniroute
```

Client point vào:

```
Base URL: https://sbu6-omniroute.dev.kaopiz.com/v1
API Key:  [copy từ Dashboard → Endpoints]
Model:    auto
```

---

## 🔄 Update sau này (nhánh `fix/cache` có commit mới)

```bash
# 1. Chạy lại workflow "Build npm artifact (fork)" trên GitHub Actions (manual)
# 2. Trên server: tải bản mới (link cố định) + cài đè
cd ~/omniroute-dl
wget -O omniroute.tgz \
  https://github.com/phonex34/OmniRoute/releases/download/build-latest/omniroute.tgz
npm install -g ./omniroute.tgz
pm2 restart omniroute
```

> `~/.omniroute` (config + DB) nguyên vẹn suốt quá trình update.

---

## ✅ Checklist

| Bước              | Ở đâu          | Việc                                                        |
| ----------------- | -------------- | ----------------------------------------------------------- |
| Build artifact    | GitHub Actions | Run workflow "Build npm artifact (fork)" (manual) → Release |
| Node + PM2 + .env | Server         | Node 24 sẵn có; `npm i -g pm2`; `.env` ở `~/.omniroute`     |
| Tải artifact      | Server         | `wget .../releases/download/build-latest/omniroute.tgz`     |
| Cài               | Server         | `npm i -g ./omniroute.tgz`                                  |
| Chạy 24/7         | Server         | `pm2 start omniroute` → `pm2 save` → `pm2 startup`          |
| HTTPS             | Server         | Caddy → domain; ufw + AWS SG mở 80,443                      |
| Update            | cả 2           | Run workflow → `wget` → `npm i -g` → `pm2 restart`          |

---

## 🐛 Troubleshooting

| Vấn đề                            | Xử lý                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `wget` 404                        | Workflow chưa chạy lần nào (Release `build-latest` chưa tồn tại) → chạy workflow trước |
| Build workflow lỗi nghi cache     | Chạy lại workflow, **tick "Clean build"**                                              |
| `invalid ELF header` / sqlite lỗi | Node server ≠ Node build (cả 2 phải Node 24) → `node -v` kiểm tra                      |
| `omniroute: command not found`    | `npm i -g` chưa xong hoặc PATH nvm chưa load → mở shell mới / `which omniroute`        |
| App không login / mất DB          | `.env` không đọc được → kiểm tra `~/.omniroute/.env` tồn tại, `DATA_DIR=` để trống     |
| `502 Bad Gateway` (Caddy)         | App chưa chạy → `pm2 status` / `pm2 logs omniroute`                                    |
| Caddy không xin được cert         | Route53 trỏ đúng EIP? AWS SG mở port 80? `sudo journalctl -u caddy -f`                 |
