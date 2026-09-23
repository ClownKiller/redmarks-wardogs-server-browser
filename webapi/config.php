<?php
/*
 * RedMarks Wardogs Server Browser - squad Web API settings
 *
 * EDIT THE LINE MARKED "CHANGE THIS" AND NOTHING ELSE.
 * Then upload this whole folder to your website and open check.php in a browser.
 */

// CHANGE THIS: your squad key. Use the key the app gave you when you created
// the squad, or make up a long random one and paste the same text into the app.
// Anyone with this key can see and post squad presence, so treat it as a password.
$SQUAD_KEY = 'change-me-to-a-long-random-key';

// How many people can be in the squad. Raise it if your crew is bigger.
$MAX_MEMBERS = 30;

// Entries older than this are forgotten automatically.
$EXPIRE_MINUTES = 180;

// Names that are never allowed to post (for removing someone quickly).
// Example: $BLOCKED_NAMES = ['Dave', 'OldMate'];
$BLOCKED_NAMES = [];

// Where presence is stored. It sits next to this file and starts with a PHP
// exit line, so nobody can read it through the web even if they guess the name.
$DATA_FILE = __DIR__ . '/squad-data.php';
