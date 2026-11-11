// Welcome thread of a new project: it proposes the first topic and leaves the choice to the operator.
// The Stop hook accepted only the start question; the welcome asked its own question and created the topic (Alice 2026-11-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { welcomeMessage, WELCOME_TOPIC_QUESTION } from '../scripts/t3-setup.mjs';
import { TOPIC_QUESTION } from '../scripts/boot.mjs';
import { NO_TOPIC_REASON } from '../hooks/stop.mjs';
import { parseReply } from '../scripts/protocol.mjs';

test('welcome: ends with the start question the Stop hook accepts, never creates the topic', () => {
  assert.equal(WELCOME_TOPIC_QUESTION, TOPIC_QUESTION);
  const msg = welcomeMessage('novy', 'novy-web');
  assert.ok(msg.includes(`**Otázky na operátora:** ${TOPIC_QUESTION}`), msg);
  assert.match(msg, /Tému nezakladaj/);
  assert.match(msg, /AskUserQuestion/);
  // The reply the welcome asks for is what topicStart recognizes (question up to the first "?").
  assert.equal(parseReply(`novy / bez témy\n\nZhrnutie.\n\n**Otázky na operátora:** ${TOPIC_QUESTION} (návrh: web – Web pre klienta)\n\nStav: otázka`).question, TOPIC_QUESTION);
});

test('Stop hook: a proposed topic is asked, not created', () => {
  assert.match(NO_TOPIC_REASON('novy'), /only propose one[^"]*do not create it/);
});
