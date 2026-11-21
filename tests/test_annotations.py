"""Black-box regression checks. Run: python3 -m unittest discover -s tests"""
import http.client
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest


SERVER = Path(__file__).resolve().parents[1] / 'scripts' / 'annotate_server.py'


class AnnotationWorkflow(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / 'site'
        self.root.mkdir()
        self.state = Path(temp.name) / 'state'
        self.state.mkdir()
        self.inbox = self.state / 'annotations-inbox.jsonl'
        self.a = {'id': 'A', 'status': 'sent', 'sentAt': 'revision-1', 'comment': 'first'}
        self.b = {'id': 'B', 'status': 'draft', 'comment': 'second'}
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.start()

    def start(self):
        self.proc = subprocess.Popen([sys.executable, '-B', str(SERVER), '--root', str(self.root),
                                      '--state-dir', str(self.state), '--port', str(self.port)],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.stop, self.proc)
        for _ in range(200):
            if self.proc.poll() is not None:
                self.fail('annotation server exited during startup')
            try:
                with socket.create_connection(('127.0.0.1', self.port), timeout=1):
                    return
            except ConnectionRefusedError:
                time.sleep(.01)
        self.fail('annotation server did not start')

    @staticmethod
    def stop(proc):
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)

    def call(self, method='GET', path='/__annotations', body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            conn.request(method, path, json.dumps(body) if body is not None else None,
                         {'Content-Type': 'application/json', **(headers or {})})
            r = conn.getresponse()
            raw = r.read()
            return r.status, json.loads(raw) if raw and r.getheader('Content-Type', '').startswith('application/json') else raw
        finally:
            conn.close()

    def save(self, version, items):
        return self.call('POST', body={'version': version, 'annotations': items})

    def resolve(self, *items):
        return self.call('POST', '/__resolve', {'annotations': [{'id': a['id'], 'sentAt': a['sentAt']} for a in items]})

    def test_stale_tab_and_stale_resolve(self):
        status, first = self.save(0, [self.a])
        self.assertEqual(status, 200)
        self.assertEqual(self.save(0, [self.b])[0], 409)
        edited = dict(self.a, sentAt='revision-2', comment='edited')
        second = dict(self.b, status='sent', sentAt='revision-1')
        status, _ = self.save(first['version'], [edited, second])
        self.assertEqual(status, 200)
        self.assertEqual(self.resolve(second, self.a)[0], 409)
        self.assertEqual(self.call()[1]['annotations'], [edited, second])
        self.assertEqual(self.resolve(edited, second)[0], 200)
        fixed = self.call()[1]
        self.assertEqual([a['status'] for a in fixed['annotations']], ['fixed', 'fixed'])
        self.assertEqual(self.save(fixed['version'], [])[0], 200)
        self.assertEqual(self.save(fixed['version'], [edited, second])[0], 409)
        self.assertEqual(self.call()[1]['annotations'], [])

    def test_sent_revision_cannot_change_and_only_resolve_can_fix(self):
        status, sent = self.save(0, [self.a])
        self.assertEqual(status, 200)
        batch = self.inbox.read_bytes()
        for bad in (dict(self.a, comment='new text'), dict(self.a, selector='#elsewhere'),
                    dict(self.a, status='fixed'), dict(self.b, status='fixed')):
            status, current = self.save(sent['version'], [bad])
            self.assertEqual(status, 409)
            self.assertEqual(current['version'], sent['version'])
            self.assertEqual(current['annotations'], [self.a])
        self.assertEqual(self.resolve(self.a)[0], 200)
        fixed = self.call()[1]
        item, = fixed['annotations']
        self.assertEqual(item['comment'], 'first')
        self.assertEqual(self.save(fixed['version'], [dict(item, comment='changed')])[0], 409)
        self.assertEqual(self.save(fixed['version'], [item, self.b])[0], 200)
        self.assertEqual(self.inbox.read_bytes(), batch)

    def test_edit_requires_fresh_delivery_even_after_restart(self):
        _, sent = self.save(0, [self.a])
        draft = dict(self.a, status='draft', comment='new text')
        del draft['sentAt']
        status, saved = self.save(sent['version'], [draft])
        self.assertEqual(status, 200)
        for items in ([draft], []):
            status, saved = self.save(saved['version'], items)
            self.assertEqual(status, 200)
            self.stop(self.proc)
            self.start()
            self.assertEqual(self.save(saved['version'], [dict(self.a, comment='new text')])[0], 409)
            self.assertEqual(self.call()[1]['annotations'], items)
        edited = dict(self.a, sentAt='revision-2', comment='new text')
        self.assertEqual(self.save(saved['version'], [edited])[0], 200)
        self.assertEqual(self.resolve(self.a)[0], 409)
        self.assertEqual(self.resolve(edited)[0], 200)
        self.assertEqual([json.loads(b)['annotations'] for b in self.inbox.read_bytes().splitlines()],
                         [[self.a], [edited]])

    def test_old_mismatched_delivery_cannot_resolve_new_text(self):
        self.stop(self.proc)
        mismatched = dict(self.a, comment='never delivered')
        (self.state / 'annotations.json').write_text(json.dumps({'version': 3, 'annotations': [mismatched]}))
        self.inbox.write_text(json.dumps({'event': 'sent', 'annotations': [self.a]}) + '\n')
        self.start()
        self.assertEqual(self.resolve(self.a)[0], 409)
        self.assertEqual(self.call()[1]['annotations'], [mismatched])
        new = dict(mismatched, sentAt='fresh-revision')
        self.assertEqual(self.save(3, [new])[0], 200)
        self.assertEqual(self.resolve(new)[0], 200)

    def test_comment_format_and_character_limit(self):
        prefix = '  first\n\tsecond\u2028third  '
        value = prefix + '\U0001d11e' * (3998 - len(prefix)) + '  '
        item = dict(self.a, comment=value)
        status, saved = self.save(0, [item])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(self.inbox.read_bytes())['annotations'][0]['comment'], value)
        line, = self.call(path='/__inbox')[1]['lines']
        self.assertEqual(json.loads(line)['annotations'][0]['comment'], value)
        self.assertEqual(self.save(saved['version'], [dict(self.b, comment=value + '!')])[0], 400)
        self.assertEqual(self.call()[1]['annotations'], [item])

    def test_injection_preserves_doctype_and_script_contents(self):
        script = b'<script>const marker = "</head>";</script>'
        for head in (b'', b'<HEAD><title>Test</title></HEAD>'):
            page = b'<!DOCTYPE html><html>' + head + script + b'<p>Target</p></html>'
            (self.root / 'index.html').write_bytes(page)
            status, body = self.call(path='/')
            self.assertEqual(status, 200)
            self.assertTrue(body.startswith(b'<!DOCTYPE html>'))
            self.assertIn(script, body)
            self.assertIn(b'/annotate.js', body)

    def test_failed_delivery_can_retry_and_survives_restart(self):
        self.inbox.mkdir()
        self.assertGreaterEqual(self.save(0, [self.a])[0], 500)
        self.stop(self.proc)
        self.inbox.rmdir()
        self.start()
        # The original client did not receive an acknowledgement. Retrying must
        # either commit or return the now-confirmed snapshot, never send twice.
        status, recovered = self.save(0, [self.a])
        self.assertIn(status, (200, 409))
        self.assertEqual(recovered['annotations'], [self.a])
        snap = self.call()[1]
        self.assertEqual(snap['annotations'], [self.a])
        self.assertEqual(self.save(snap['version'], [self.a, self.b])[0], 200)
        batches = [json.loads(line)['annotations'] for line in self.inbox.read_text().splitlines()]
        self.assertEqual(batches, [[self.a]])

    def test_existing_state_and_inbox_upgrade(self):
        self.stop(self.proc)
        (self.state / 'annotations.json').write_text(json.dumps({'annotations': [self.a]}))
        batch = json.dumps({'event': 'sent', 'annotations': [self.a]}) + '\n'
        self.inbox.write_text(batch)
        self.start()
        snapshot = self.call()[1]
        self.assertEqual(snapshot['annotations'], [self.a])
        self.assertEqual(self.save(snapshot['version'], [self.a, self.b])[0], 200)
        self.assertEqual(self.inbox.read_text(), batch)

    def test_limit_is_all_or_nothing(self):
        items = [dict(self.b, id=str(i)) for i in range(500)]
        status, saved = self.save(0, items)
        self.assertEqual(status, 200)
        self.assertEqual(self.save(saved['version'], items + [self.a])[0], 413)
        self.assertEqual(self.call()[1]['annotations'], items)
        self.assertFalse(self.inbox.exists() and self.inbox.stat().st_size)

    def test_http_boundary_and_injection(self):
        (self.root / 'index.html').write_text('<!doctype html><head></head><p>Target</p>')
        self.assertIn(b'/annotate.js', self.call(path='/')[1])
        self.assertEqual(self.call('HEAD', '/index.html')[0], 200)
        outside = self.state / 'sample.txt'
        outside.write_text('sample')
        (self.root / 'linked.txt').symlink_to(outside)
        for method in ('GET', 'HEAD'):
            self.assertIn(self.call(method, '/linked.txt')[0], (403, 404))
        self.assertIn(self.call(headers={'Host': 'not-local.invalid'})[0], (400, 403, 421))
        save = {'version': 0, 'annotations': [self.b]}
        for headers in ({'Origin': 'https://other.invalid'}, {'Content-Type': 'text/plain'}):
            self.assertIn(self.call('POST', body=save, headers=headers)[0], (400, 403, 415))
        self.assertEqual(self.call()[1]['annotations'], [])


if __name__ == '__main__':
    unittest.main()
