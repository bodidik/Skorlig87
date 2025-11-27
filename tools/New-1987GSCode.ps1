param(
    [int]    $Count    = 5,             # Kaç kod üretilecek
    [int]    $MaxUses  = 500,           # Her kod için max kullanım
    [string] $Label    = "1987GS dalga",# Etiket
    [string] $Prefix   = "GS87-"        # Kod prefix'i
)

# Script'in bulunduğu klasörü baz al (api\tools altına koyarsan güvenli)
$root     = $PSScriptRoot
$dataPath = Join-Path $root "..\data"
$file     = Join-Path $dataPath "gs1987-codes.json"

if (-not (Test-Path $dataPath)) {
    New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
}

# Mevcut JSON'u oku veya iskelet oluştur
if (Test-Path $file) {
    $json = Get-Content $file -Raw | ConvertFrom-Json
} else {
    $json = [pscustomobject]@{
        codes     = @()
        updatedAt = $null
    }
}

if (-not $json.codes) {
    $json | Add-Member -NotePropertyName codes -NotePropertyValue @()
}

# Kod üretici (karışık harf/rakam, I/O/1 gibi karışık karakterler yok)
function New-1987GsCode([string]$Pfx) {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $rnd   = -join (1..6 | ForEach-Object { $chars[(Get-Random -Max $chars.Length)] })
    return "$Pfx$rnd"
}

# Mevcut kod listesi (case-insensitive karşılaştırma için normalize ediyoruz)
$currentCodes = @()
if ($json.codes) {
    $currentCodes = $json.codes | ForEach-Object { ($_).code.ToUpper() }
}

Write-Host "📌 Dosya:" $file
Write-Host "🎯 Üretilecek kod sayısı:" $Count
Write-Host ""

for ($i = 1; $i -le $Count; $i++) {
    $code = New-1987GsCode $Prefix

    # Çakışmayı engelle
    while ($currentCodes -contains $code.ToUpper()) {
        $code = New-1987GsCode $Prefix
    }

    $json.codes += [pscustomobject]@{
        code    = $code
        maxUses = $MaxUses
        used    = 0
        label   = $Label
    }
    $currentCodes += $code.ToUpper()

    Write-Host ("➕ {0} (maxUses={1}, label='{2}')" -f $code, $MaxUses, $Label)
}

$json.updatedAt = (Get-Date).ToString("o")

# JSON'u geri yaz
$json | ConvertTo-Json -Depth 5 | Set-Content -Path $file -Encoding UTF8

Write-Host ""
Write-Host "✅ Güncellendi:" $file
