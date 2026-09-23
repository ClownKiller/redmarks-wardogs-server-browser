<?php
/*
 * RedMarks Wardogs Server Browser - squad Web API check page
 *
 * Open this in your web browser after uploading. It tells you in plain English
 * whether everything is ready. Delete this file afterwards if you like.
 */

declare(strict_types=1);
require __DIR__ . '/config.php';

$checks = [];
$checks[] = ['PHP version is new enough (7.4 or later)', version_compare(PHP_VERSION, '7.4', '>='), 'Your host is running PHP ' . PHP_VERSION . '. Ask them to switch you to a newer version.'];
$checks[] = ['The squad key has been changed', $SQUAD_KEY !== 'change-me-to-a-long-random-key' && strlen($SQUAD_KEY) >= 12, 'Open config.php and replace the example key with the one from the app.'];
$checks[] = ['squad.php is in this folder', is_file(__DIR__ . '/squad.php'), 'Upload squad.php next to this file.'];

$writable = false;
$testFile = __DIR__ . '/squad-write-test.tmp';
if (@file_put_contents($testFile, 'x') !== false) { $writable = true; @unlink($testFile); }
$checks[] = ['This folder can be written to', $writable, 'Your host must allow this folder to be written to (permissions 755 usually work).'];

$secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['SERVER_PORT'] ?? '') === '443';
$checks[] = ['The page is being served over https', $secure, 'The app only accepts https addresses. Turn on SSL for your site (most hosts offer it free).'];

$allGood = true;
foreach ($checks as $c) { if (!$c[1]) $allGood = false; }

$url = ($secure ? 'https://' : 'http://') . ($_SERVER['HTTP_HOST'] ?? 'yoursite') . str_replace('check.php', 'squad.php', $_SERVER['REQUEST_URI'] ?? '/squad.php');
$url = strtok($url, '?');
?><!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Squad API check</title>
<style>
body{background:#0A0A0A;color:#fff;font-family:Segoe UI,Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.5}
h1{color:#F28C28} li{margin:10px 0} .good{color:#5ED17A} .bad{color:#E5484D} code{background:#1a1a1a;padding:3px 7px;border-radius:4px;word-break:break-all}
.box{background:#141414;border-left:3px solid #F28C28;padding:12px 16px;margin:20px 0}
</style></head><body>
<h1>RedMarks Wardogs Server Browser: squad API check</h1>
<ul>
<?php foreach ($checks as $c): ?>
  <li><span class="<?= $c[1] ? 'good' : 'bad' ?>"><?= $c[1] ? 'OK' : 'PROBLEM' ?></span> &mdash; <?= htmlspecialchars($c[0]) ?><?= $c[1] ? '' : '<br><small>' . htmlspecialchars($c[2]) . '</small>' ?></li>
<?php endforeach; ?>
</ul>
<?php if ($allGood): ?>
  <div class="box"><strong>Everything is ready.</strong><br>Put this address into the app, under Settings, Squad, Web API:<br><code><?= htmlspecialchars($url) ?></code></div>
  <p>Then paste in your squad code and the same key from config.php, and send your mates the invite line the app gives you.</p>
<?php else: ?>
  <div class="box">Fix the items marked PROBLEM above, then reload this page.</div>
<?php endif; ?>
<p><small>This page only checks your setup. It never shows squad presence.</small></p>
</body></html>
