$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://localhost:8089/')
$listener.Start()
Write-Host 'Server running at http://localhost:8089'

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json'
    '.png'  = 'image/png'
    '.svg'  = 'image/svg+xml'
}
$base = 'C:\Users\叉虫\Desktop\时间管理大师\public'

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $path = $req.Url.LocalPath -replace '^/', ''
    if ($path -eq '') { $path = 'index.html' }
    $file = Join-Path $base $path
    if (Test-Path $file) {
        $ext = [IO.Path]::GetExtension($file)
        $res.ContentType = if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' }
        $bytes = [IO.File]::ReadAllBytes($file)
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $res.StatusCode = 404
        $msg = [Text.Encoding]::UTF8.GetBytes('404 - Not Found')
        $res.ContentLength64 = $msg.Length
        $res.OutputStream.Write($msg, 0, $msg.Length)
    }
    $res.Close()
}
