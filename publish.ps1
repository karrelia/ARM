# Збирає теку «для публікації» — лише файли, що йдуть на сервер, — і ZIP поруч.
# Запуск із теки проєкту:   .\publish.ps1
# Теку бази arm-data НЕ копіює: на сервері вона лишається недоторканою.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$out  = Join-Path $root 'для публікації'

# що публікується (все інше — git, тести, налаштування — на сервер не потрібне)
$items = @(
  'index.html', 'support.js', 'sw.js', 'manifest.webmanifest', 'favicon.ico',
  'api.php', 'server.js', '.htaccess', '.nojekyll',
  'icons', 'vendor'
)

# версія застосунку — для назви архіву (APP_VERSION в index.html)
$ver = ''
$m = Select-String -Path (Join-Path $root 'index.html') -Pattern "APP_VERSION\(\)\{ return '([^']+)'" | Select-Object -First 1
if ($m) { $ver = $m.Matches[0].Groups[1].Value }

# свіжа тека: старі файли прибираємо, щоб не лишилось видаленого з проєкту
if (Test-Path $out) { Remove-Item $out -Recurse -Force -Confirm:$false }
New-Item -ItemType Directory -Path $out | Out-Null
foreach ($it in $items) {
  $src = Join-Path $root $it
  if (-not (Test-Path $src)) { Write-Warning "немає: $it"; continue }
  Copy-Item -Path $src -Destination $out -Recurse -Force
}

# ZIP із вмістом теки (у корені архіву — index.html, а не тека)
$zipName = 'ARM-onovlennia' + $(if ($ver) { '-' + $ver } else { '' }) + '.zip'
$zip = Join-Path $out $zipName
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip -Force
# Compress-Archive пропускає файли з крапкою на початку (.htaccess, .nojekyll) — дописуємо
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::Open($zip, 'Update')
foreach ($dot in @('.htaccess', '.nojekyll')) {
  $p = Join-Path $out $dot
  if ((Test-Path $p) -and -not $z.GetEntry($dot)) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $p, $dot) | Out-Null }
}
$z.Dispose()

# інструкція — у теку, але НЕ в архів (на сервер вона не потрібна)
$guide = @'
ТЕКА «ДЛЯ ПУБЛІКАЦІЇ» — що завантажувати на сервер

Тут лише файли застосунку, які йдуть на сервер. Теку збирає publish.ps1
з теки проєкту — після кожної зміни просто запустіть його знову.
Поруч лежить ZIP-архів з тим самим вмістом.

ЯК ОНОВИТИ СЕРВЕР
1. Резервна копія: у застосунку «Виконавець» → «Зберегти копію у файл».
2. Скопіюйте вміст цієї теки (або розпакуйте ZIP) у теку сайту на сервері
   поверх старих файлів, з заміною. Цей txt-файл копіювати не треба.
3. Теку arm-data на сервері НЕ видаляйте й не перезаписуйте —
   там база, користувачі й фото.
4. Сервер на Node (server.js) — перезапустіть. Apache з api.php — нічого не треба.

На сервер НЕ йдуть: arm-data, .git, tests, .github, .claude, README.md, .gitignore.
'@
$guideName = 'ЯК ОНОВИТИ СЕРВЕР.txt'
[IO.File]::WriteAllText((Join-Path $out $guideName), $guide, (New-Object Text.UTF8Encoding $true))

$n = (Get-ChildItem $out -Recurse -File | Where-Object { $_.Name -ne $zipName -and $_.Name -ne $guideName }).Count
Write-Host "Готово: «для публікації» — $n файлів, архів $zipName (версія $ver)"
Write-Host 'На сервері: розпакуйте/скопіюйте вміст у теку сайту поверх старого. Теку arm-data НЕ чіпайте.'
