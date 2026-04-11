<?php
// Default landing page — replace with your app
header('Content-Type: text/plain');

echo "LEMP Stack is running.\n\n";

// Redis check
try {
    $r = new Redis();
    $r->connect('lemp_redis', 6379);
    $r->set('healthcheck', 'ok');
    echo "Redis: " . $r->get('healthcheck') . "\n";
} catch (Exception $e) {
    echo "Redis: FAILED (" . $e->getMessage() . ")\n";
}

// MariaDB check
$host = getenv('DB_HOST') ?: 'lemp_db';
$user = getenv('DB_USER') ?: 'user';
$pass = getenv('DB_PASSWORD') ?: 'password';
$name = getenv('DB_NAME') ?: 'mydb';

$conn = @new mysqli($host, $user, $pass, $name);
if ($conn->connect_error) {
    echo "MySQL: FAILED (" . $conn->connect_error . ")\n";
} else {
    echo "MySQL: connected\n";
    $conn->close();
}
