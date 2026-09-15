import React, { useEffect, useRef, useState } from 'react';
import { api, getStoredUser } from '../api.js';

// In-trip chat between the customer and their driver. The parent owns the
// socket (it uses it for trip/location events too) and passes it here; we only
// subscribe to chat events and clean them up on unmount.
export default function Chat({ tripId, socket, maxHeight = 300, label = '💬 Message your driver' }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const bottomRef = useRef(null);

  const selfId = getStoredUser()?.id;

  useEffect(() => {
    if (!tripId) return undefined;
    let alive = true;
    api(`/chat/trips/${tripId}/messages`)
      .then((r) => alive && Array.isArray(r.messages) && setMessages(r.messages))
      .catch(() => alive && setError('Could not load messages'))
      .finally(() => alive && setLoaded(true));

    // Live incoming messages from the other participant.
    const onMessage = (data) => {
      const msg = data?.message;
      if (!msg || msg.tripId !== tripId) return;
      setMessages((cur) => (cur.some((m) => m.id === msg.id) ? cur : [...cur, msg]));
      // We've seen it — tell the sender.
      api(`/chat/trips/${tripId}/read`, { method: 'POST' }).catch(() => {});
    };
    const onRead = () => {
      // The other side read our messages; no-op for now (reserved for read receipts).
    };
    if (socket) {
      socket.on('chat:message', onMessage);
      socket.on('chat:read', onRead);
    }
    return () => {
      alive = false;
      if (socket) {
        socket.off('chat:message', onMessage);
        socket.off('chat:read', onRead);
      }
    };
  }, [tripId, socket]);

  // Keep the newest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  async function send(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await api(`/chat/trips/${tripId}/messages`, { method: 'POST', body: { body } });
      if (res.message) setMessages((cur) => [...cur, res.message]);
      setDraft('');
    } catch (err) {
      setError(err.message || 'Could not send message');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat-wrap">
      <div className="chat-header">
        <span>{label}</span>
        <span className="hint" style={{ margin: 0 }}>{loaded ? `${messages.length} messages` : '…'}</span>
      </div>
      <div className="chat-list" style={{ maxHeight }}>
        {!loaded && <p className="hint">Loading…</p>}
        {loaded && messages.length === 0 && <p className="hint">No messages yet — say hi to your driver.</p>}
        {messages.map((m) => <Bubble key={m.id} message={m} mine={m.senderId === selfId} />)}
        <div ref={bottomRef} />
      </div>
      {error && <p className="error" style={{ margin: '6px 0' }}>{error}</p>}
      <form className="chat-compose" onSubmit={send}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a message…"
          maxLength={2000}
          aria-label="Message"
        />
        <button className="btn primary" type="submit" disabled={sending || !draft.trim()}>
          {sending ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function Bubble({ message, mine }) {
  return (
    <div className={`chat-bubble ${mine ? 'mine' : 'theirs'}`}>
      <span className="chat-bubble-body">{message.body}</span>
      <span className="chat-bubble-time">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  );
}