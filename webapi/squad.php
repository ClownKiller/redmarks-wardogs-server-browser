<?php
/*
 * RedMarks Wardogs Server Browser - squad Web API
 *
 * The app talks to this file. It stores who is heading to which server, for a
 * few hours, in a plain file next to this script. No database needed.
 *
 * Everything it accepts: a squad code, the key from config.php, a display
 * name, a WARDOGS join code, a server name and a region. Nothing else is kept.
 */

declare(strict_types=1);
require __DIR__ . '/config.php';

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function reply(int $status, array $body): void {
    http_response_code($status);
    echo json_encode($body);
    exit;
}

function clean(?string $value, int $max): string {
    $value = (string) $value;
    $value = preg_replace('/[\x00-\x1F<>]/u', '', $value);
    if ($value === null) $value = '';
    // mbstring isn't installed on every host, so fall back to plain substr.
    $short = function_exists('mb_substr') ? mb_substr($value, 0, $max) : substr($value, 0, $max);
    return trim($short);
}

/** Official join codes are digits; community ones are a UUID. */
function is_join_code(string $code): bool {
    return (bool) (preg_match('/^[0-9]{1,64}$/', $code)
        || preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $code));
}

function load_all(string $file): array {
    if (!is_file($file)) return [];
    $raw = (string) file_get_contents($file);
    $at = strpos($raw, "\n");
    if ($at === false) return [];
    $data = json_decode(substr($raw, $at + 1), true);
    return is_array($data) ? $data : [];
}

function save_all(string $file, array $data): void {
    $out = "<?php exit; ?>\n" . json_encode($data);
    $tmp = $file . '.tmp';
    file_put_contents($tmp, $out, LOCK_EX);
    rename($tmp, $file); // swapped in whole, so a crash never leaves half a file
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    reply(405, ['ok' => false, 'error' => 'This address is used by the RedMarks Wardogs Server Browser app. Open check.php to test your setup.']);
}

$input = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($input)) reply(400, ['ok' => false, 'error' => 'Unreadable request.']);

$action = clean($input['action'] ?? '', 20);
$squad  = clean($input['squad'] ?? '', 40);
$key    = (string) ($input['key'] ?? '');
$name   = clean($input['name'] ?? '', 24);

if ($SQUAD_KEY === 'change-me-to-a-long-random-key') {
    reply(500, ['ok' => false, 'error' => 'This squad API has not been set up yet: the key in config.php is still the example one.']);
}
if (!hash_equals($SQUAD_KEY, $key)) {
    reply(403, ['ok' => false, 'error' => 'Wrong squad key.']);
}
if ($squad === '') {
    reply(400, ['ok' => false, 'error' => 'No squad code given.']);
}
if ($name !== '' && in_array($name, $BLOCKED_NAMES, true)) {
    reply(403, ['ok' => false, 'error' => 'That name has been removed from this squad.']);
}

$all = load_all($DATA_FILE);
$members = isset($all[$squad]) && is_array($all[$squad]) ? $all[$squad] : [];
$cutoff = time() - ($EXPIRE_MINUTES * 60);

// Forget stale entries, in every squad, on every request.
foreach ($all as $code => $list) {
    if (!is_array($list)) { unset($all[$code]); continue; }
    $all[$code] = array_values(array_filter($list, static fn($m) => ($m['at'] ?? 0) >= $cutoff));
    if (!$all[$code]) unset($all[$code]);
}
$members = array_values(array_filter($members, static fn($m) => ($m['at'] ?? 0) >= $cutoff));

if ($action === 'checkin') {
    $code = clean($input['code'] ?? '', 64);
    if (!is_join_code($code)) reply(400, ['ok' => false, 'error' => 'That is not a WARDOGS join code.']);
    if ($name === '') reply(400, ['ok' => false, 'error' => 'No display name given.']);

    $members = array_values(array_filter($members, static fn($m) => ($m['name'] ?? '') !== $name));
    if (count($members) >= $MAX_MEMBERS) {
        reply(429, ['ok' => false, 'error' => "This squad is full ({$MAX_MEMBERS} members). Raise MAX_MEMBERS in config.php."]);
    }
    $members[] = [
        'name' => $name,
        'code' => $code,
        'serverName' => clean($input['serverName'] ?? '', 80),
        'region' => clean($input['region'] ?? '', 40),
        'at' => time(),
    ];
    $all[$squad] = $members;
    save_all($DATA_FILE, $all);
    reply(200, ['ok' => true]);
}

if ($action === 'leave') {
    $all[$squad] = array_values(array_filter($members, static fn($m) => ($m['name'] ?? '') !== $name));
    if (!$all[$squad]) unset($all[$squad]);
    save_all($DATA_FILE, $all);
    reply(200, ['ok' => true]);
}

if ($action === 'roster') {
    $all[$squad] = $members;
    save_all($DATA_FILE, $all);
    $now = time();
    $out = array_map(static fn($m) => [
        'name' => $m['name'] ?? '',
        'code' => $m['code'] ?? '',
        'serverName' => $m['serverName'] ?? '',
        'region' => $m['region'] ?? '',
        'ageSeconds' => max(0, $now - (int) ($m['at'] ?? $now)),
    ], $members);
    reply(200, ['ok' => true, 'members' => $out]);
}

reply(400, ['ok' => false, 'error' => 'Unknown action.']);
