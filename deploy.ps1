# ─────────────────────────────────────────────────────────────────────────────
# deploy.ps1 — Atualiza a PRODUÇÃO a partir do GitHub.
# Rode NA MÁQUINA SERVIDOR (a que roda o pm2):   .\deploy.ps1
# Fluxo: dev empurra no GitHub  ->  aqui você roda este script  ->  produção no ar.
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot   # raiz do repositório

Write-Host "==> 1/5 Puxando as últimas mudanças do GitHub..." -ForegroundColor Cyan
git pull

Write-Host "==> 2/5 Instalando dependências..." -ForegroundColor Cyan
npm --prefix backend  install --no-audit --no-fund
npm --prefix frontend install --no-audit --no-fund

Write-Host "==> 3/5 Compilando o backend (tsc -> dist)..." -ForegroundColor Cyan
npm --prefix backend run build

Write-Host "==> 4/5 Compilando o frontend (vite -> dist)..." -ForegroundColor Cyan
Push-Location frontend
npx vite build
Pop-Location

Write-Host "==> 5/5 Reiniciando a produção (pm2)..." -ForegroundColor Cyan
pm2 restart distre

Write-Host "`n==> PRODUÇÃO ATUALIZADA com sucesso! ✅" -ForegroundColor Green
Write-Host "    (a janela do túnel cloudflared precisa continuar aberta para o acesso público)" -ForegroundColor DarkGray
