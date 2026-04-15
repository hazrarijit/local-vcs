<?php
/**
 * sync-ftp.php - Remote Server Sync Handler
 * 
 * Single entry point for all SyncVCS remote operations.
 * Handles connection testing and file synchronization via HTTP.
 * 
 * DEPLOYMENT: Place this file on your remote PHP server.
 * Only the files pushed from the SyncVCS desktop client will be
 * created or updated in the SYNC_ROOT directory.
 */

// ========================
// CONFIGURATION
// ========================

define('SECURE_KEY', 'SYNCVCS_SECURE_KEY_2024');
define('SYNC_ROOT', __DIR__);
define('MAX_FILE_SIZE', 50 * 1024 * 1024); // 50 MB

// ========================
// CORS & HEADERS
// ========================

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// ========================
// HELPERS
// ========================

function respond($data, $statusCode = 200) {
    http_response_code($statusCode);
    echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    exit;
}

function respondError($message, $statusCode = 400) {
    respond(['status' => 'error', 'message' => $message], $statusCode);
}

function validateKey($key) {
    if (empty($key) || $key !== SECURE_KEY) {
        respondError('Unauthorized: Invalid security key.', 401);
    }
}

function sanitizePath($filePath) {
    if (strpos($filePath, '..') !== false) {
        respondError('Forbidden: Path traversal detected.', 403);
    }
    if (strpos($filePath, "\0") !== false) {
        respondError('Forbidden: Invalid path.', 403);
    }

    $filePath = str_replace('\\', '/', $filePath);
    $filePath = ltrim($filePath, '/');

    if (preg_match('/^[a-zA-Z]:/', $filePath)) {
        respondError('Forbidden: Absolute paths not allowed.', 403);
    }

    // Use the actual SYNC_ROOT path (create first if needed)
    if (!is_dir(SYNC_ROOT)) {
        mkdir(SYNC_ROOT, 0755, true);
    }
    $syncRoot = realpath(SYNC_ROOT);
    $targetPath = $syncRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $filePath);

    return $targetPath;
}

function ensureDirectory($filePath) {
    $dir = dirname($filePath);
    if (!is_dir($dir)) {
        if (!@mkdir($dir, 0755, true)) {
            respondError('Server error: Could not create directory: ' . $dir, 500);
        }
    }
}

function logSync($action, $filePath, $status, $details = '') {
    $logDir = __DIR__ . '/sync-logs';
    if (!is_dir($logDir)) {
        @mkdir($logDir, 0755, true);
    }

    $entry = json_encode([
        'timestamp' => date('Y-m-d H:i:s'),
        'action'    => $action,
        'file'      => $filePath,
        'status'    => $status,
        'details'   => $details,
        'ip'        => $_SERVER['REMOTE_ADDR'] ?? 'unknown'
    ]) . "\n";

    @file_put_contents($logDir . '/sync-' . date('Y-m-d') . '.log', $entry, FILE_APPEND | LOCK_EX);
}

// ========================
// ENSURE SYNC ROOT
// ========================

if (!is_dir(SYNC_ROOT)) {
    mkdir(SYNC_ROOT, 0755, true);
}

// ========================
// READ INPUT ONCE (critical fix: php://input can only be read once)
// ========================

$rawBody = file_get_contents('php://input');
$jsonBody = null;

if (!empty($rawBody)) {
    $jsonBody = json_decode($rawBody, true);
}

// ========================
// ROUTING
// ========================

$action = $_GET['action'] ?? '';
$key = $_GET['key'] ?? '';

// Try key from POST form data, then from JSON body
if (empty($key)) {
    $key = $_POST['key'] ?? '';
}
if (empty($key) && $jsonBody) {
    $key = $jsonBody['key'] ?? '';
}

switch ($action) {

    // ========================
    // ACTION: CONNECT
    // ========================
    case 'connect':
        validateKey($key);

        respond([
            'status'  => 'success',
            'message' => 'Connection established.',
            'server'  => [
                'php_version' => PHP_VERSION,
                'sync_root'   => basename(SYNC_ROOT),
                'writable'    => is_writable(SYNC_ROOT),
                'max_upload'  => ini_get('upload_max_filesize'),
                'post_max'    => ini_get('post_max_size'),
                'timestamp'   => date('Y-m-d H:i:s')
            ]
        ]);
        break;

    // ========================
    // ACTION: SYNC FILE
    // ========================
    case 'sync-file':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respondError('Method not allowed. Use POST.', 405);
        }

        if (!$jsonBody || !is_array($jsonBody)) {
            respondError('Invalid or empty JSON payload. Raw length: ' . strlen($rawBody));
        }

        $payloadKey = $jsonBody['key'] ?? '';
        validateKey($payloadKey);

        $filePath   = $jsonBody['file_path'] ?? '';
        $fileData   = $jsonBody['file_data'] ?? '';
        $actionType = $jsonBody['action_type'] ?? 'update';

        if (empty($filePath)) {
            respondError('Missing required field: file_path');
        }

        // Sanitize and resolve the target path
        $absolutePath = sanitizePath($filePath);

        // ----- DELETE -----
        if ($actionType === 'delete') {
            if (file_exists($absolutePath)) {
                if (@unlink($absolutePath)) {
                    logSync('delete', $filePath, 'success');

                    // Clean empty parent dirs up to SYNC_ROOT
                    $syncRoot = realpath(SYNC_ROOT);
                    $dir = dirname($absolutePath);
                    while ($dir !== $syncRoot && is_dir($dir) && count(scandir($dir)) <= 2) {
                        @rmdir($dir);
                        $dir = dirname($dir);
                    }

                    respond([
                        'status'  => 'success',
                        'message' => 'File deleted successfully.',
                        'file'    => $filePath
                    ]);
                } else {
                    logSync('delete', $filePath, 'failed', error_get_last()['message'] ?? '');
                    respondError('Failed to delete file.', 500);
                }
            } else {
                respond([
                    'status'  => 'success',
                    'message' => 'File already deleted.',
                    'file'    => $filePath
                ]);
            }
            break;
        }

        // ----- ADD / UPDATE -----
        if (empty($fileData)) {
            respondError('Missing required field: file_data (base64 content)');
        }

        $decodedContent = base64_decode($fileData, true);
        if ($decodedContent === false) {
            respondError('Invalid base64 encoded file data.');
        }

        $fileSize = strlen($decodedContent);
        if ($fileSize > MAX_FILE_SIZE) {
            respondError('File exceeds maximum allowed size (' . round(MAX_FILE_SIZE / 1024 / 1024) . ' MB).');
        }

        // Ensure parent directory exists
        ensureDirectory($absolutePath);

        // Write ONLY this specific file
        $bytesWritten = @file_put_contents($absolutePath, $decodedContent, LOCK_EX);

        if ($bytesWritten !== false) {
            logSync($actionType, $filePath, 'success', "Wrote {$bytesWritten} bytes");

            respond([
                'status'    => 'success',
                'message'   => 'File synced successfully.',
                'file'      => $filePath,
                'size'      => $bytesWritten,
                'timestamp' => date('Y-m-d H:i:s')
            ]);
        } else {
            $err = error_get_last();
            logSync($actionType, $filePath, 'failed', $err['message'] ?? 'Unknown error');
            respondError('Failed to write file. Error: ' . ($err['message'] ?? 'Unknown'), 500);
        }
        break;

    // ========================
    // ACTION: LIST FILES
    // ========================
    case 'list':
        validateKey($key);

        $syncRoot = realpath(SYNC_ROOT);
        if (!$syncRoot || !is_dir($syncRoot)) {
            respond(['status' => 'success', 'files' => [], 'count' => 0]);
        }

        $files = [];
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($syncRoot, RecursiveDirectoryIterator::SKIP_DOTS),
            RecursiveIteratorIterator::SELF_FIRST
        );

        foreach ($iterator as $file) {
            if ($file->isFile()) {
                $rel = str_replace('\\', '/', substr($file->getPathname(), strlen($syncRoot) + 1));
                $files[] = [
                    'path'     => $rel,
                    'size'     => $file->getSize(),
                    'modified' => date('Y-m-d H:i:s', $file->getMTime())
                ];
            }
        }

        respond(['status' => 'success', 'files' => $files, 'count' => count($files)]);
        break;

    // ========================
    // UNKNOWN ACTION
    // ========================
    default:
        respondError('Unknown action: ' . htmlspecialchars($action ?? ''), 400);
        break;
}
