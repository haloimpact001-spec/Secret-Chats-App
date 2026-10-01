'use client';
import type { MediaConnection, Peer as PeerType } from 'peerjs';
import { useState, useEffect, useRef, useCallback } from 'react';
import { generateKey, exportKeyToBase64, importKeyFromBase64, encryptText, decryptText } from '@/lib/crypto';
import { Phone, Video, PhoneOff, Mic, MicOff, VideoOff, User, CheckCircle, Image as ImageIcon, Send, Lock, MessageCircle, MoreVertical, Copy, Volume2, AlertCircle, X, Check } from 'lucide-react';

// --- Web Audio helpers (one shared context; browsers cap how many can exist) ---
type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

const createAudioContext = (): AudioContext => {
  const Ctor = window.AudioContext || (window as AudioWindow).webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio is not supported in this browser');
  return new Ctor();
};

let sharedAudioContext: AudioContext | null = null;
const getSharedAudioContext = (): AudioContext => {
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = createAudioContext();
  }
  if (sharedAudioContext.state === 'suspended') void sharedAudioContext.resume();
  return sharedAudioContext;
};

// --- Sound Effects System ---
const playSound = (type: 'load' | 'send' | 'receive' | 'call') => {
  try {
    const audioContext = getSharedAudioContext();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    const t = audioContext.currentTime;

    if (type === 'load') {
      oscillator.frequency.setValueAtTime(523.25, t);
      oscillator.frequency.setValueAtTime(659.25, t + 0.1);
      gainNode.gain.setValueAtTime(0.1, t);
      gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
      oscillator.start(t);
      oscillator.stop(t + 0.3);
    } else if (type === 'send') {
      oscillator.frequency.setValueAtTime(880, t);
      gainNode.gain.setValueAtTime(0.05, t);
      gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
      oscillator.start(t);
      oscillator.stop(t + 0.1);
    } else if (type === 'receive') {
      oscillator.frequency.setValueAtTime(1046.5, t);
      gainNode.gain.setValueAtTime(0.05, t);
      gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
      oscillator.start(t);
      oscillator.stop(t + 0.15);
    } else if (type === 'call') {
      oscillator.frequency.setValueAtTime(440, t);
      gainNode.gain.setValueAtTime(0.1, t);
      gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
      oscillator.start(t);
      oscillator.stop(t + 0.5);
    }
  } catch (e) { console.error('Audio error:', e); }
};

// --- Celebration Sound Synthesizer (Zero Dependencies) ---
const playCelebrationSound = () => {
  try {
    const audioContext = getSharedAudioContext();
    const t = audioContext.currentTime;

    // 1. The "Poooooop" Sound (Rapid pitch drop)
    const popOsc = audioContext.createOscillator();
    const popGain = audioContext.createGain();
    popOsc.connect(popGain);
    popGain.connect(audioContext.destination);
    popOsc.type = 'sine';
    popOsc.frequency.setValueAtTime(800, t);
    popOsc.frequency.exponentialRampToValueAtTime(100, t + 0.15);
    popGain.gain.setValueAtTime(0.3, t);
    popGain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
    popOsc.start(t);
    popOsc.stop(t + 0.15);

    // 2. The "Congratulations" Chime (Ascending Major Chord)
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, i) => {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t + 0.15 + i * 0.08);
      gain.gain.setValueAtTime(0, t + 0.15 + i * 0.08);
      gain.gain.linearRampToValueAtTime(0.15, t + 0.2 + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.01, t + 0.8 + i * 0.08);
      osc.start(t + 0.15 + i * 0.08);
      osc.stop(t + 1.0 + i * 0.08);
    });
  } catch (e) { console.error('Celebration audio error:', e); }
};

// --- LocalStorage Helpers (guarded: storage can throw in private mode) ---
const saveProfileToStorage = (profileBase64: string) => {
  try { if (typeof window !== 'undefined') localStorage.setItem('secretChat_profile', profileBase64); } catch { /* storage unavailable */ }
};
const loadProfileFromStorage = (): string | null => {
  try { if (typeof window !== 'undefined') return localStorage.getItem('secretChat_profile'); } catch { /* storage unavailable */ }
  return null;
};
const clearProfileFromStorage = () => {
  try { if (typeof window !== 'undefined') localStorage.removeItem('secretChat_profile'); } catch { /* storage unavailable */ }
};

// --- Cryptographically strong room ID generator ---
const generateRoomId = (length = 8): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(length);
  if (typeof window !== 'undefined' && window.crypto) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 4294967295);
  }
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
};

// Numeric, time-ordered, collision-resistant (Date.now() alone overwrote messages sent in the same ms)
const generateMessageId = (): string =>
  `${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

// --- Per-tab, per-room sender id ---
const getOrCreateSenderId = (roomKey: string): string => {
  const fresh = `User_${Math.random().toString(36).substring(2, 7)}`;
  if (typeof window === 'undefined') return fresh;
  try {
    const storageKey = `secretChat_sender_${roomKey}`;
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    sessionStorage.setItem(storageKey, fresh);
  } catch { /* storage unavailable */ }
  return fresh;
};

const safeDecode = (value: string): string => {
  try { return decodeURIComponent(value); } catch { return value; }
};

// --- URL fragment helpers ---
const readRoomAndKeyFromLocation = (): { room: string | null; key: string | null } => {
  if (typeof window === 'undefined') return { room: null, key: null };
  const hash = window.location.hash.startsWith('#') ? window.location.hash.substring(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  return { room: params.get('room'), key: params.get('key') };
};

const buildShareUrl = (roomId: string, encodedKey: string): string => {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}${window.location.pathname}#room=${roomId}&key=${encodedKey}`;
};

// --- Professional Zero-Dependency Canvas Confetti Physics Engine ---
interface Particle {
  x: number; y: number; vx: number; vy: number;
  size: number; color: string; rotation: number; rotationSpeed: number;
}

const Confetti = ({ active }: { active: boolean }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#FFD700', '#FF4500', '#00FF7F', '#1E90FF', '#FF69B4', '#9400D3', '#FFFFFF'];
    particlesRef.current = [];

    // Explosion: 150 particles bursting from the center
    for (let i = 0; i < 150; i++) {
      const angle = Math.random() * Math.PI * 2;
      const velocity = Math.random() * 15 + 5;
      particlesRef.current.push({
        x: canvas.width / 2,
        y: canvas.height / 2,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity - 5, // Upward bias
        size: Math.random() * 8 + 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 10,
      });
    }

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let activeParticles = false;

      particlesRef.current.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.4; // Gravity
        p.vx *= 0.98; // Air resistance
        p.rotation += p.rotationSpeed;

        if (p.y < canvas.height + 50) {
          activeParticles = true;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate((p.rotation * Math.PI) / 180);
          ctx.fillStyle = p.color;
          ctx.shadowBlur = 10;
          ctx.shadowColor = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size / 2);
          ctx.restore();
        }
      });

      if (activeParticles) {
        animationRef.current = requestAnimationFrame(animate);
      }
    };
    animate();

    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-[100]" />;
};

// --- Voice-note level bars (restored: it was deleted in the last commit but still used) ---
const AudioVisualizer = ({ level }: { level: number }) => {
  return (
    <div className="flex items-center justify-center space-x-1 h-8 w-32">
      {[1, 2, 3, 4, 5, 6, 7].map((i) => {
        const waveOffset = Math.sin(i * 1.2) * 25;
        const h = Math.max(15, Math.min(100, level + waveOffset));
        return (
          <div
            key={i}
            className="w-1.5 bg-red-500 rounded-full transition-all duration-75 ease-out"
            style={{ height: `${h}%` }}
          />
        );
      })}
    </div>
  );
};

// --- Animated background: owns its own state so the 60fps animation doesn't re-render the whole chat ---
const AnimatedBackground = () => {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setPhase((prev) => (prev + 1) % 360);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      <div className="absolute inset-0" style={{ background: `linear-gradient(${phase}deg, rgba(99, 102, 241, 0.3) 0%, rgba(168, 85, 247, 0.3) 50%, rgba(15, 23, 42, 0.4) 100%)` }}></div>
      <div className="absolute inset-0 bg-gradient-to-bl from-purple-950/30 via-transparent to-indigo-950/30" style={{ opacity: Math.sin((phase * Math.PI) / 180) * 0.5 + 0.5, transform: `rotate(${phase}deg)` }}></div>
    </div>
  );
};

interface MessageData {
  id: string;
  payload: string;
  type?: string;
  sender?: string;
  text?: string; // filled in after decryption
}

type CallKind = 'voice' | 'video';
type CallWithPC = MediaConnection & { peerConnection?: RTCPeerConnection };
interface IncomingCall { call: MediaConnection; type: CallKind; callerId: string }

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export default function SecretChat() {
  // --- DOM refs ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const profileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const callMenuRef = useRef<HTMLDivElement>(null);

  // --- Latest-value refs (async callbacks created once must not read stale state) ---
  const cryptoKeyRef = useRef<CryptoKey | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const senderIdRef = useRef<string>('');
  const profilePicRef = useRef<string>('');
  const remotePeerRef = useRef<string | null>(null);
  const incomingCallRef = useRef<IncomingCall | null>(null);

  // --- Peer / call refs ---
  const myPeerIdRef = useRef<string | null>(null);
  const peerInstance = useRef<PeerType | null>(null);
  const initializingPeerRef = useRef(false);
  const peerAnnounceRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentCall = useRef<MediaConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processedSysRef = useRef<Set<string>>(new Set());

  // --- Voice note refs ---
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingSecondsRef = useRef(0);
  const cancelledRecordingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Core State ---
  const [roomId, setRoomId] = useState<string | null>(null);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [roomKeyBase64, setRoomKeyBase64] = useState<string>(''); // always the URL-encoded form
  const [isJoined, setIsJoined] = useState(false);
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [inputText, setInputText] = useState('');
  const [viewingImage, setViewingImage] = useState<{ url: string; id: string } | null>(null);
  const [viewedImages, setViewedImages] = useState<Set<string>>(new Set());
  const [senderId, setSenderId] = useState<string>('');
  // Lazy init: the loading screen is always shown first, so this can't cause a hydration mismatch
  const [profilePic, setProfilePic] = useState<string>(() => loadProfileFromStorage() ?? '');
  const [peerProfiles, setPeerProfiles] = useState<Record<string, string>>({});
  const [decryptedAudios, setDecryptedAudios] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);

  // --- Call State ---
  const [remotePeerId, setRemotePeerId] = useState<string | null>(null);
  const [callState, setCallState] = useState<'idle' | 'outgoing' | 'incoming' | 'connected' | 'declined' | 'failed'>('idle');
  const [callType, setCallType] = useState<CallKind>('video');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [incomingCallData, setIncomingCallData] = useState<IncomingCall | null>(null);
  const [, setConnectionStatus] = useState('Initializing...');
  const [callError, setCallError] = useState<string | null>(null);
  const [webrtcConnectionState, setWebrtcConnectionState] = useState<string>('new');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  // --- Voice Note State ---
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);

  // --- Celebration State ---
  const [showCelebration, setShowCelebration] = useState(false);

  // --- UI State ---
  const [showLanding, setShowLanding] = useState(true);
  const [joinRoomId, setJoinRoomId] = useState('');
  const [joinRoomKey, setJoinRoomKey] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [showContent, setShowContent] = useState(false);
  const [showRoomDetails, setShowRoomDetails] = useState(false);
  const [showCallMenu, setShowCallMenu] = useState(false);

  const callStateRef = useRef(callState);
  useEffect(() => { callStateRef.current = callState; }, [callState]);
  useEffect(() => { profilePicRef.current = profilePic; }, [profilePic]);

  // =========================================================
  // Helpers (declared in dependency order)
  // =========================================================
  const showNotice = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setNotice({ text, kind });
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 3000);
  }, []);

  // One place that encrypts + posts. Reads refs so it is never stale.
  const postEncrypted = useCallback(async (plain: string, type: string, sender: string): Promise<boolean> => {
    const key = cryptoKeyRef.current;
    const room = roomIdRef.current;
    if (!key || !room) return false;
    try {
      const encryptedPayload = await encryptText(plain, key);
      const res = await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: room, messageId: generateMessageId(), encryptedPayload, senderId: sender, type }),
      });
      return res.ok;
    } catch (err) {
      console.error('Post failed', err);
      return false;
    }
  }, []);

  const sendSystemMessage = useCallback(
    (text: string) => postEncrypted(text, 'system', 'SYSTEM'),
    [postEncrypted]
  );

  const cleanupRecording = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
  }, []);

  const clearCallTimeout = useCallback(() => {
    if (callTimeoutRef.current) { clearTimeout(callTimeoutRef.current); callTimeoutRef.current = null; }
  }, []);

  const endCall = useCallback(() => {
    clearCallTimeout();
    // Null the ref BEFORE closing: close() fires the 'close' event, which calls endCall again
    const call = currentCall.current;
    currentCall.current = null;
    call?.close();
    const pending = incomingCallRef.current;
    incomingCallRef.current = null;
    pending?.call.close();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);
    setCallState('idle');
    setIncomingCallData(null);
    setIsMuted(false);
    setIsVideoOff(false);
    setCallError(null);
    setWebrtcConnectionState('new');
  }, [clearCallTimeout]);

  // User pressed the red button: tell the other side, then tear down
  const hangUp = useCallback(() => {
    if (callStateRef.current !== 'idle') {
      void sendSystemMessage(`__SYS_CALL_END__::${senderIdRef.current}`);
    }
    endCall();
  }, [endCall, sendSystemMessage]);

  const declineCall = useCallback(() => {
    clearCallTimeout();
    if (incomingCallRef.current) {
      void sendSystemMessage(`__SYS_CALL_DECLINED__::${senderIdRef.current}`);
    }
    endCall();
  }, [clearCallTimeout, endCall, sendSystemMessage]);

  const wireCall = useCallback((call: MediaConnection) => {
    currentCall.current = call;
    const pc = (call as CallWithPC).peerConnection;
    if (pc) {
      pc.addEventListener('connectionstatechange', () => {
        setWebrtcConnectionState(pc.connectionState);
        if (pc.connectionState === 'failed') {
          showNotice('Call connection lost', 'error');
          endCall();
        } else if (pc.connectionState === 'closed') {
          endCall();
        } else if (pc.connectionState === 'disconnected') {
          setCallError('Connection degraded. Reconnecting...');
        } else if (pc.connectionState === 'connected') {
          setCallError(null);
        }
      });
    }
    call.on('stream', (stream) => {
      setRemoteStream(stream);
      setCallState('connected');
      clearCallTimeout();
    });
    call.on('close', () => endCall());
    call.on('error', () => {
      showNotice('Call failed. Please try again.', 'error');
      endCall();
    });
  }, [clearCallTimeout, endCall, showNotice]);

  const initializePeer = useCallback(async () => {
    if (peerInstance.current || initializingPeerRef.current) return;
    initializingPeerRef.current = true;
    try {
      // DYNAMIC IMPORT: PeerJS touches browser globals, so it must not load during SSR/build
      const { default: Peer } = await import('peerjs');

      const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
      const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME;
      const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;

      const iceServers: RTCIceServer[] = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ];
      if (turnUrl && turnUsername && turnCredential) {
        iceServers.push({ urls: turnUrl, username: turnUsername, credential: turnCredential });
      }

      const peer = new Peer({
        host: '0.peerjs.com',
        port: 443,
        secure: true,
        debug: 2,
        config: { iceServers, iceCandidatePoolSize: 10 },
      });

      peer.on('open', (id) => {
        myPeerIdRef.current = id;
        setConnectionStatus('Network Connected. Waiting for peer...');
        const announce = () => { void sendSystemMessage(`__SYS_PEER__::${senderIdRef.current}::${id}`); };
        announce();
        // Messages expire after 5 minutes, so re-announce to stay discoverable
        if (peerAnnounceRef.current) clearInterval(peerAnnounceRef.current);
        peerAnnounceRef.current = setInterval(announce, 120000);
      });

      peer.on('call', (call) => {
        if (callStateRef.current !== 'idle') { call.close(); return; }
        const meta = call.metadata as { type?: CallKind; callerId?: string } | undefined;
        const type: CallKind = meta?.type === 'voice' ? 'voice' : 'video';
        const data: IncomingCall = { call, type, callerId: meta?.callerId || 'Unknown' };
        incomingCallRef.current = data;
        setIncomingCallData(data);
        setCallType(type);
        setCallState('incoming');
        playSound('call');

        clearCallTimeout();
        callTimeoutRef.current = setTimeout(() => {
          if (callStateRef.current === 'incoming') declineCall();
        }, 30000);
      });

      peer.on('disconnected', () => {
        setConnectionStatus('Reconnecting...');
        setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 2000);
      });

      peer.on('error', (err) => {
        console.error('PeerJS Error:', err);
        setConnectionStatus('Network Error');
        if ((err as { type?: string }).type === 'peer-unavailable' && callStateRef.current === 'outgoing') {
          showNotice('Peer is unavailable right now', 'error');
          endCall();
        }
      });

      peerInstance.current = peer;
    } finally {
      initializingPeerRef.current = false;
    }
  }, [sendSystemMessage, clearCallTimeout, declineCall, endCall, showNotice]);

  // Set every piece of room state (and the matching refs) in one place
  const applyRoom = useCallback((room: string, key: CryptoKey, encodedKey: string) => {
    const sid = getOrCreateSenderId(room);
    roomIdRef.current = room;
    cryptoKeyRef.current = key;
    senderIdRef.current = sid;
    setRoomId(room);
    setCryptoKey(key);
    setRoomKeyBase64(encodedKey);
    setSenderId(sid);
    setIsJoined(true);
    setShowLanding(false);
  }, []);

  // =========================================================
  // Effects
  // =========================================================
  useEffect(() => {
    playSound('load');
    const timer = setTimeout(() => {
      setIsLoading(false);
      setTimeout(() => setShowContent(true), 300);
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (callMenuRef.current && !callMenuRef.current.contains(e.target as Node)) {
        setShowCallMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Attach streams to <video> elements AFTER they render (the stream can arrive before the element exists)
  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream, callState, callType]);
  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream, callState, callType]);

  // Teardown on unmount
  useEffect(() => {
    return () => {
      currentCall.current?.close();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      peerInstance.current?.destroy();
      peerInstance.current = null; // otherwise a re-mount (React StrictMode) thinks a peer still exists
      initializingPeerRef.current = false;
      if (peerAnnounceRef.current) clearInterval(peerAnnounceRef.current);
      if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      cleanupRecording();
    };
  }, [cleanupRecording]);

  // Open a room straight from a share link (#room=...&key=...)
  useEffect(() => {
    const { room, key } = readRoomAndKeyFromLocation();
    if (!room || !key) return;
    let cancelled = false;
    importKeyFromBase64(safeDecode(key))
      .then((imported) => {
        if (cancelled) return;
        applyRoom(room, imported, encodeURIComponent(safeDecode(key)));
        setConnectionStatus('Connecting to Secure Network...');
        void initializePeer();
      })
      .catch((err) => {
        console.error('Key import failed', err);
        showNotice('This room link is invalid or incomplete', 'error');
      });
    return () => { cancelled = true; };
  }, [applyRoom, initializePeer, showNotice]);

  // --- POLLING ENGINE ---
  useEffect(() => {
    if (!isJoined || !roomId || !cryptoKey) return;
    let active = true;
    let inFlight = false;
    let firstFetch = true;
    let lastSignature = '';
    const seenIds = new Set<string>();

    const handleSystemText = (text: string) => {
      const me = senderIdRef.current;
      if (text.startsWith('__SYS_PEER__::')) {
        const [, sender, pId] = text.split('::');
        if (sender && pId && sender !== me && pId !== myPeerIdRef.current) {
          const changed = remotePeerRef.current !== pId;
          remotePeerRef.current = pId;
          setRemotePeerId(pId);
          setConnectionStatus('Peer Connected & Encrypted');
          if (changed) void sendSystemMessage(`__SYS_REQUEST_PROFILES__::${me}`);
        }
      } else if (text.startsWith('__SYS_REQUEST_PROFILES__')) {
        const requester = text.split('::')[1];
        if (requester !== me && profilePicRef.current) {
          void sendSystemMessage(`__SYS_PROFILE__::${me}::${profilePicRef.current}`);
        }
      } else if (text.startsWith('__SYS_PROFILE__::')) {
        const payload = text.substring('__SYS_PROFILE__::'.length);
        const idx = payload.indexOf('::');
        if (idx !== -1) {
          const pSender = payload.substring(0, idx);
          const pBase64 = payload.substring(idx + 2);
          setPeerProfiles((prev) => ({ ...prev, [pSender]: pBase64 }));
        }
      } else if (text.startsWith('__SYS_CALL_DECLINED__')) {
        if (text.split('::')[1] !== me && callStateRef.current === 'outgoing') {
          endCall();
          showNotice('Call declined', 'error');
        }
      } else if (text.startsWith('__SYS_CALL_END__')) {
        if (text.split('::')[1] !== me && callStateRef.current !== 'idle') {
          endCall();
          showNotice('Call ended');
        }
      }
    };

    const fetchMessages = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/message?roomId=${encodeURIComponent(roomId)}`);
        const data = await res.json();
        if (!active || !data.success) return;

        const raw = (data.messages as MessageData[]).slice().sort((a, b) => Number(a.id) - Number(b.id));
        const decrypted = await Promise.all(
          raw.map(async (msg) => {
            try {
              return { ...msg, text: await decryptText(msg.payload, cryptoKey) };
            } catch {
              return { ...msg, text: '[Error]' };
            }
          })
        );
        if (!active) return;

        const visible: MessageData[] = [];
        let gotNewFromOthers = false;
        for (const msg of decrypted) {
          if (msg.type === 'system') {
            // Each system message is acted on exactly once (they used to be re-run every second)
            if (!processedSysRef.current.has(msg.id)) {
              processedSysRef.current.add(msg.id);
              handleSystemText(msg.text);
            }
            continue;
          }
          visible.push(msg);
          if (!seenIds.has(msg.id)) {
            seenIds.add(msg.id);
            if (!firstFetch && msg.sender !== senderIdRef.current) gotNewFromOthers = true;
          }
        }
        firstFetch = false;
        if (gotNewFromOthers) playSound('receive');

        // Only touch state (and trigger auto-scroll) when something actually changed
        const signature = visible.map((m) => m.id).join(',');
        if (signature !== lastSignature) {
          lastSignature = signature;
          setMessages(visible);
        }
      } catch (err) {
        console.error('Failed to fetch messages', err);
      } finally {
        inFlight = false;
      }
    };

    void fetchMessages();
    const interval = setInterval(fetchMessages, 1000);
    return () => { active = false; clearInterval(interval); };
  }, [isJoined, roomId, cryptoKey, sendSystemMessage, endCall, showNotice]);

  // =========================================================
  // Room actions
  // =========================================================
  const createRoom = async () => {
    try {
      const newRoomId = generateRoomId();
      const key = await generateKey();
      const encodedKey = encodeURIComponent(await exportKeyToBase64(key));

      applyRoom(newRoomId, key, encodedKey);
      setShowRoomDetails(true);

      // --- TRIGGER CELEBRATION ---
      setShowCelebration(true);
      playCelebrationSound();
      setTimeout(() => setShowCelebration(false), 4000);

      window.history.pushState({}, '', `${window.location.pathname}#room=${newRoomId}&key=${encodedKey}`);
      void initializePeer();
    } catch (err) {
      console.error('Create room failed', err);
      showNotice('Could not create a secure room. Encryption needs HTTPS.', 'error');
    }
  };

  const joinRoom = async () => {
    if (!joinRoomId.trim() || !joinRoomKey.trim()) {
      showNotice('Please enter both Room ID and Secret Key', 'error');
      return;
    }
    const normalizedRoomId = joinRoomId.trim().toUpperCase();
    const rawKey = safeDecode(joinRoomKey.trim());
    try {
      const key = await importKeyFromBase64(rawKey);
      const encodedKey = encodeURIComponent(rawKey);
      applyRoom(normalizedRoomId, key, encodedKey);
      setConnectionStatus('Connecting...');
      window.history.pushState({}, '', `${window.location.pathname}#room=${normalizedRoomId}&key=${encodedKey}`);
      void initializePeer();
    } catch (err) {
      console.error('Key import failed', err);
      showNotice('Invalid Secret Key. Please check and try again.', 'error');
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
      .then(() => showNotice(`${label} copied!`))
      .catch(() => showNotice('Copy failed. Please copy it manually.', 'error'));
  };

  // =========================================================
  // Messaging
  // =========================================================
  const sendMessage = async () => {
    if (!inputText.trim()) return;
    const ok = await postEncrypted(inputText, 'text', senderIdRef.current);
    if (ok) {
      setInputText('');
      playSound('send');
    } else {
      showNotice('Message failed to send. Check your connection.', 'error');
    }
  };

  // --- VOICE NOTE FUNCTIONS ---
  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') recorder.stop();
    if (recordingIntervalRef.current) { clearInterval(recordingIntervalRef.current); recordingIntervalRef.current = null; }
    setIsRecording(false);
    setAudioLevel(0);
  };

  const cancelRecording = () => {
    cancelledRecordingRef.current = true; // checked in onstop, so late data chunks are discarded
    audioChunksRef.current = [];
    stopRecording();
    cleanupRecording();
  };

  const sendVoiceNote = async (audioBlob: Blob) => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(audioBlob);
      });
      const ok = await postEncrypted(dataUrl, 'audio', senderIdRef.current);
      if (ok) playSound('send');
      else showNotice('Voice note failed to send (it may be too large).', 'error');
    } catch (error) {
      console.error('Voice note failed', error);
      showNotice('Voice note failed to send.', 'error');
    }
  };

  const startRecording = async () => {
    if (isRecording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = createAudioContext();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyserRef.current = analyser;
      analyser.fftSize = 256;
      audioContext.createMediaStreamSource(stream).connect(analyser);

      const updateVisualizer = () => {
        if (!analyserRef.current) return;
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const average = sum / dataArray.length;
        setAudioLevel(Math.min(100, Math.max(0, (average / 255) * 100 * 2.5)));
        animationFrameRef.current = requestAnimationFrame(updateVisualizer);
      };
      updateVisualizer();

      // Low bitrate keeps a 60s note under the ~1MB request limit of the Redis REST API
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 24000 });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      cancelledRecordingRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && !cancelledRecordingRef.current) audioChunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        const cancelled = cancelledRecordingRef.current;
        cancelledRecordingRef.current = false;
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        audioChunksRef.current = [];
        cleanupRecording();
        if (!cancelled && blob.size > 0) await sendVoiceNote(blob);
      };

      recorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      recordingSecondsRef.current = 0;

      recordingIntervalRef.current = setInterval(() => {
        recordingSecondsRef.current += 1;
        setRecordingTime(recordingSecondsRef.current);
        if (recordingSecondsRef.current >= 60) stopRecording(); // auto-send at 60s
      }, 1000);
    } catch (err) {
      console.error('Microphone access denied:', err);
      cleanupRecording();
      showNotice('Microphone access denied. Please check browser permissions.', 'error');
    }
  };

  const loadAudio = async (msgId: string, encryptedBase64: string) => {
    if (decryptedAudios[msgId] || !cryptoKey) return;
    try {
      const decryptedDataUrl = await decryptText(encryptedBase64, cryptoKey);
      setDecryptedAudios((prev) => ({ ...prev, [msgId]: decryptedDataUrl }));
    } catch (error) {
      console.error('Audio decrypt failed', error);
    }
  };

  // =========================================================
  // Call actions
  // =========================================================
  const startCall = async (type: CallKind) => {
    if (!remotePeerId || !peerInstance.current) {
      showNotice('Waiting for the other person to join the room first...', 'error');
      return;
    }
    if (callStateRef.current !== 'idle') return;

    setShowCallMenu(false);
    setCallType(type);
    setCallState('outgoing');
    setCallError(null);
    playSound('call');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: type === 'video', audio: true });
      localStreamRef.current = stream;
      setLocalStream(stream);

      const call = peerInstance.current.call(remotePeerId, stream, { metadata: { type, callerId: senderIdRef.current } });
      wireCall(call);

      clearCallTimeout();
      callTimeoutRef.current = setTimeout(() => {
        if (callStateRef.current === 'outgoing') {
          showNotice('No answer', 'error');
          hangUp();
        }
      }, 30000);
    } catch (err) {
      showNotice(`Camera/Mic blocked: ${errMsg(err)}. Use HTTPS and allow permissions.`, 'error');
      endCall();
    }
  };

  const acceptCall = async () => {
    const data = incomingCallRef.current;
    if (!data) return;
    clearCallTimeout();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: data.type === 'video', audio: true });
      localStreamRef.current = stream;
      setLocalStream(stream);
      data.call.answer(stream);

      incomingCallRef.current = null;
      setIncomingCallData(null);
      setCallType(data.type);
      setCallState('connected');
      wireCall(data.call);
    } catch (err) {
      showNotice(`Camera/Mic blocked: ${errMsg(err)}. Check browser settings.`, 'error');
      declineCall();
    }
  };

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextMuted = !isMuted;
    localStreamRef.current.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
    setIsMuted(nextMuted);
  }, [isMuted]);

  const toggleVideo = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextOff = !isVideoOff;
    localStreamRef.current.getVideoTracks().forEach((track) => { track.enabled = !nextOff; });
    setIsVideoOff(nextOff);
  }, [isVideoOff]);

  // =========================================================
  // Images
  // =========================================================
  const compressImage = (file: File, maxW: number, quality: number): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new Image();
        img.src = event.target?.result as string;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let w = img.width, h = img.height;
          if (w > maxW) { h = Math.round((h * maxW) / w); w = maxW; }
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return reject(new Error('Canvas failed'));
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('Image load failed'));
      };
      reader.onerror = () => reject(reader.error);
    });
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImage(file, 800, 0.6);
      const ok = await postEncrypted(compressed, 'image', senderIdRef.current);
      if (ok) playSound('send');
      else showNotice('Image failed to send.', 'error');
    } catch (error) {
      console.error('Image failed', error);
      showNotice('Could not process that image.', 'error');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleProfileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImage(file, 100, 0.5);
      setProfilePic(compressed);
      saveProfileToStorage(compressed);
      if (cryptoKeyRef.current && roomIdRef.current) {
        await sendSystemMessage(`__SYS_PROFILE__::${senderIdRef.current}::${compressed}`);
      }
    } catch (error) {
      console.error('Profile failed', error);
      showNotice('Could not process that image.', 'error');
    }
    if (profileInputRef.current) profileInputRef.current.value = '';
  };

  const removeProfilePic = () => {
    setProfilePic('');
    clearProfileFromStorage();
  };

  const openImage = async (msgId: string, encryptedBase64: string) => {
    if (!cryptoKey || viewedImages.has(msgId)) return;
    try {
      const decryptedDataUrl = await decryptText(encryptedBase64, cryptoKey);
      setViewingImage({ url: decryptedDataUrl, id: msgId });
    } catch (error) { console.error('Decrypt failed', error); }
  };

  const closeImageViewer = () => {
    if (viewingImage) {
      const id = viewingImage.id;
      setViewedImages((prev) => new Set(prev).add(id));
      setViewingImage(null);
      fetch(`/api/message?roomId=${encodeURIComponent(roomId ?? '')}&messageId=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
  };

  const handleTouch = (e: React.MouseEvent | React.TouchEvent) => {
    const touch = 'touches' in e ? e.touches[0] : e;
    if (!touch) return;
    const ripple = document.createElement('div');
    ripple.className = 'fixed w-32 h-32 bg-white/20 rounded-full pointer-events-none animate-ping z-50';
    ripple.style.left = `${touch.clientX - 64}px`;
    ripple.style.top = `${touch.clientY - 64}px`;
    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 1000);
  };

  // --- Shared UI pieces (used by several screens below) ---
  const toast = notice ? (
    <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[120] px-4 py-2 rounded-full text-[11px] font-sans shadow-lg backdrop-blur-sm flex items-center space-x-2 text-white ${notice.kind === 'error' ? 'bg-red-500/90' : 'bg-emerald-500/90'}`}>
      {notice.kind === 'error' ? <AlertCircle size={14} /> : <CheckCircle size={14} />}
      <span>{notice.text}</span>
    </div>
  ) : null;

  const celebration = (
    <>
      <Confetti active={showCelebration} />
      {showCelebration && (
        <div className="fixed inset-0 z-[101] flex items-center justify-center pointer-events-none">
          <div className="bg-black/80 backdrop-blur-md px-10 py-6 rounded-3xl border-2 border-yellow-400/50 shadow-2xl animate-bounce">
            <h2 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 via-pink-400 to-purple-400 font-sans tracking-wider text-center">
              🎉 Congratulations! 🎉
            </h2>
            <p className="text-white text-sm text-center mt-2 font-sans font-semibold">Secure Vault Successfully Created</p>
          </div>
        </div>
      )}
    </>
  );

  const showRemoteVideo = callType === 'video' && callState === 'connected' && !!remoteStream;

  // --- LOADING SCREEN ---
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex flex-col items-center justify-center" onClick={handleTouch}>
        <div className="relative">
          <div className="absolute inset-0 bg-indigo-500 rounded-full animate-ping opacity-20"></div>
          <div className="relative w-32 h-32 bg-white/10 backdrop-blur-xl rounded-3xl flex items-center justify-center border border-white/20 shadow-2xl">
            <img src="/images/imagea.png" alt="Secret Chats" className="w-24 h-24 object-contain animate-pulse rounded-3xl" />
          </div>
        </div>
        <div className="mt-8 text-center">
          <h2 className="text-2xl font-bold text-white mb-2 tracking-wider font-sans">SECRET CHATS</h2>
          <h1 className="text-xs text-white mb-1 tracking-wider font-sans">Built by Habeeb_Ekong</h1>
          <div className="flex items-center space-x-2 text-indigo-300">
            <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
            <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
            <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
          </div>
          <p className="text-gray-400 text-xs mt-4 font-sans">Loading secure environment...</p>
        </div>
      </div>
    );
  }

  // --- LANDING PAGE ---
  if (showLanding) {
    return (
      <div className={`min-h-screen bg-cover bg-center bg-fixed transition-opacity duration-700 ${showContent ? 'opacity-100' : 'opacity-0'}`} style={{ backgroundImage: "url('/images/bg-pattern.png')" }} onClick={handleTouch}>
        {toast}
        <div className="min-h-screen bg-slate-950/90 backdrop-blur-md flex flex-col">
          <div className={`bg-white/10 backdrop-blur-xl shadow-lg p-4 flex items-center justify-between transition-all duration-700 delay-100 ${showContent ? 'translate-y-0 opacity-100' : '-translate-y-10 opacity-0'}`}>
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg">
                <img src="/images/imagea.png" alt="Logo" className="w-7 h-7 object-contain rounded-xl" />
              </div>
              <h1 className="text-lg font-bold text-white font-sans">SECRET CHATS</h1>
            </div>
            <div className="flex items-center space-x-1 text-gray-300">
              <Lock size={14} />
              <span className="text-[9px]">End-to-end encrypted</span>
            </div>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center p-6 space-y-6">
            <div className={`text-center space-y-4 transition-all duration-700 delay-200 ${showContent ? 'translate-y-0 opacity-100' : 'translate-y-10 opacity-0'}`}>
              <div className="w-28 h-28 mx-auto bg-gradient-to-br from-indigo-500 to-purple-600 rounded-3xl flex items-center justify-center shadow-2xl">
                <img src="/images/imagea.png" alt="Secret Chats" className="w-20 h-20 object-contain rounded-3xl" />
              </div>
              <h2 className="text-2xl font-bold text-white font-sans">Secret Chats</h2>
              <p className="text-gray-400 text-[11px] max-w-xs mx-auto font-sans">We are bringing the act of private communication in a secret place to a digital form.</p>
            </div>
            <div className={`w-full max-w-xs space-y-3 transition-all duration-700 delay-300 ${showContent ? 'translate-y-0 opacity-100' : 'translate-y-10 opacity-0'}`}>
              <button onClick={createRoom} className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-semibold py-3 px-5 rounded-xl shadow-lg transition-all transform hover:scale-105 flex items-center justify-center space-x-2 text-[13px]">
                <MessageCircle size={16} />
                <span>Start Private Conversation</span>
              </button>
              <div className="relative">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-700"></div></div>
                <div className="relative flex justify-center text-xs"><span className="px-3 bg-slate-900/50 text-gray-400 rounded">or</span></div>
              </div>
              <div className={`bg-white/5 backdrop-blur-xl p-4 rounded-xl shadow-md border border-gray-800 space-y-2 transition-all duration-700 delay-400 ${showContent ? 'translate-y-0 opacity-100' : 'translate-y-10 opacity-0'}`}>
                <p className="text-[11px] font-medium text-gray-300 text-center font-sans">Join A Room for a Private Conversation</p>
                <input type="text" placeholder="Room ID" value={joinRoomId} onChange={(e) => setJoinRoomId(e.target.value)} className="w-full px-3 py-2 bg-slate-900/50 border border-gray-700 rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] text-white placeholder-gray-500" />
                <input type="text" placeholder="Secret Key" value={joinRoomKey} onChange={(e) => setJoinRoomKey(e.target.value)} className="w-full px-3 py-2 bg-slate-900/50 border border-gray-700 rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] text-white placeholder-gray-500" />
                <button onClick={joinRoom} className="w-full bg-slate-800 hover:bg-slate-700 text-white font-semibold py-2 px-4 rounded-lg transition-all flex items-center justify-center space-x-1 text-[11px]">
                  <Lock size={12} />
                  <span>Join Room</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- ROOM DETAILS MODAL ---
  if (showRoomDetails && roomId && cryptoKey) {
    const roomUrl = roomId && roomKeyBase64 ? buildShareUrl(roomId, roomKeyBase64) : '';
    return (
      <>
        {toast}
        {celebration}

        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-4" onClick={handleTouch}>
          <div className="bg-slate-900/90 backdrop-blur-xl border border-gray-800 rounded-2xl p-6 max-w-sm w-full space-y-4 shadow-2xl">
            <div className="text-center">
              <div className="w-16 h-16 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center mx-auto mb-3">
                <Lock className="w-8 h-8 text-white" />
              </div>
              <h3 className="text-lg font-bold text-white font-sans">Room Created</h3>
              <p className="text-gray-400 text-[11px] mt-1 font-sans">Share these details to invite someone</p>
            </div>
            <div className="space-y-3">
              <div className="bg-slate-950/50 p-3 rounded-lg border border-gray-800">
                <p className="text-[10px] text-gray-500 mb-1 font-sans">Room ID</p>
                <div className="flex items-center justify-between">
                  <p className="text-indigo-400 font-mono text-[13px] font-bold">{roomId}</p>
                  <button onClick={() => copyToClipboard(roomId, 'Room ID')} className="text-gray-400 hover:text-white"><Copy size={14} /></button>
                </div>
              </div>
              <div className="bg-slate-950/50 p-3 rounded-lg border border-gray-800">
                <p className="text-[10px] text-gray-500 mb-1 font-sans">Secret Key</p>
                <div className="flex items-center justify-between">
                  <p className="text-purple-400 font-mono text-[10px] truncate max-w-[180px]">{roomKeyBase64.substring(0, 30)}...</p>
                  <button onClick={() => copyToClipboard(roomKeyBase64, 'Secret Key')} className="text-gray-400 hover:text-white flex-shrink-0 ml-2"><Copy size={14} /></button>
                </div>
              </div>
              <div className="bg-slate-950/50 p-3 rounded-lg border border-gray-800">
                <p className="text-[10px] text-gray-500 mb-1 font-sans">Share Entry Link</p>
                <div className="flex items-center justify-between">
                  <p className="text-gray-300 text-[10px] truncate max-w-[180px]">{roomUrl.substring(0, 25)}...</p>
                  <button onClick={() => copyToClipboard(roomUrl, 'Link')} className="text-gray-400 hover:text-white flex-shrink-0 ml-2"><Copy size={14} /></button>
                </div>
              </div>
            </div>
            <button onClick={() => setShowRoomDetails(false)} className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-semibold py-3 rounded-xl transition-all text-[13px]">
              Enter Chat Room
            </button>
          </div>
        </div>
      </>
    );
  }

  // --- INCOMING CALL MODAL ---
  if (callState === 'incoming' && incomingCallData) {
    return (
      <div className="fixed inset-0 z-50 bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex flex-col items-center justify-between py-24 px-4" onClick={handleTouch}>
        <div className="flex flex-col items-center space-y-6">
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center overflow-hidden border-4 border-white/20 shadow-2xl animate-pulse">
            {peerProfiles[incomingCallData.callerId] ? <img src={peerProfiles[incomingCallData.callerId]} className="w-full h-full object-cover" alt="Caller" /> : <User size={64} className="text-white" />}
          </div>
          <div className="text-center">
            <h2 className="text-xl font-bold text-white font-sans">{incomingCallData.callerId}</h2>
            <p className="text-gray-400 text-[11px] mt-1 font-sans">Incoming {incomingCallData.type === 'video' ? 'Video' : 'Voice'} Call...</p>
          </div>
        </div>
        <div className="flex items-center space-x-16 pb-10">
          <button onClick={declineCall} className="relative z-20 flex flex-col items-center space-y-2 cursor-pointer group">
            <div className="w-16 h-16 rounded-full bg-red-500/90 flex items-center justify-center shadow-lg backdrop-blur-sm group-hover:scale-110 transition-transform"><PhoneOff size={28} className="text-white" /></div>
            <span className="text-white text-[11px] font-sans">Decline</span>
          </button>
          <button onClick={acceptCall} className="relative z-20 flex flex-col items-center space-y-2 cursor-pointer group">
            <div className="w-16 h-16 rounded-full bg-green-500/90 flex items-center justify-center shadow-lg backdrop-blur-sm animate-pulse group-hover:scale-110 transition-transform"><Phone size={28} className="text-white" /></div>
            <span className="text-white text-[11px] font-sans">Answer</span>
          </button>
        </div>
      </div>
    );
  }

  // --- ACTIVE CALL OVERLAY ---
  if (callState === 'outgoing' || callState === 'connected' || callState === 'declined' || callState === 'failed') {
    return (
      <div className="fixed inset-0 z-50 bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-950 flex flex-col" onClick={handleTouch}>
        {callError && (
          <div className="absolute top-6 left-1/2 -translate-x-1/2 bg-red-500/90 text-white text-[11px] px-4 py-2 rounded-full backdrop-blur-sm flex items-center space-x-2 shadow-lg z-50 animate-pulse">
            <AlertCircle size={14} />
            <span>{callError}</span>
          </div>
        )}
        <div className="relative flex-1 flex items-center justify-center">
          <video ref={remoteVideoRef} autoPlay playsInline className={showRemoteVideo ? 'absolute inset-0 w-full h-full object-cover' : 'absolute h-px w-px opacity-0 pointer-events-none'} />
          {showRemoteVideo ? null : (
            <div className="flex flex-col items-center space-y-6">
              <div className="w-40 h-40 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center overflow-hidden border-4 border-white/20 shadow-2xl">
                {remotePeerId && peerProfiles[remotePeerId] ? <img src={peerProfiles[remotePeerId]} className="w-full h-full object-cover" alt="Peer" /> : <User size={80} className="text-white" />}
              </div>
              <div className="text-center">
                <h2 className="text-lg font-bold text-white font-sans">
                  {callState === 'outgoing' ? 'Calling...' : callState === 'declined' ? 'Call Declined' : callState === 'failed' ? 'Call Failed' : 'Connected'}
                </h2>
                <p className="text-gray-400 text-[11px] mt-1 font-sans">{callType === 'video' ? 'Video' : 'Voice'} Call</p>
                {webrtcConnectionState === 'checking' && <p className="text-indigo-400 text-[10px] mt-1 animate-pulse">Establishing secure tunnel...</p>}
              </div>
            </div>
          )}
          {callType === 'video' && (callState === 'connected' || callState === 'outgoing') && (
            <video ref={localVideoRef} autoPlay playsInline muted className="absolute bottom-24 right-4 w-28 h-40 object-cover border-2 border-indigo-500/50 rounded-2xl bg-black shadow-2xl" />
          )}
        </div>

        {callState !== 'declined' && callState !== 'failed' && (
          <div className="bg-slate-950/90 backdrop-blur-xl p-6 flex flex-col items-center border-t border-gray-800 space-y-6">
            <div className="flex items-center space-x-12">
              <button className="flex flex-col items-center space-y-1 opacity-50">
                <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center"><Volume2 size={20} className="text-white" /></div>
                <span className="text-[10px] text-gray-400 font-sans">Speaker</span>
              </button>
              <button onClick={toggleMute} className="flex flex-col items-center space-y-1">
                <div className={`w-12 h-12 rounded-full ${isMuted ? 'bg-white' : 'bg-slate-800'} flex items-center justify-center transition-all`}>
                  {isMuted ? <MicOff size={20} className="text-slate-900" /> : <Mic size={20} className="text-white" />}
                </div>
                <span className="text-[10px] text-gray-400 font-sans">{isMuted ? 'Unmute' : 'Mute'}</span>
              </button>
              {callType === 'video' && (
                <button onClick={toggleVideo} className="flex flex-col items-center space-y-1">
                  <div className={`w-12 h-12 rounded-full ${isVideoOff ? 'bg-white' : 'bg-slate-800'} flex items-center justify-center transition-all`}>
                    {isVideoOff ? <VideoOff size={20} className="text-slate-900" /> : <Video size={20} className="text-white" />}
                  </div>
                  <span className="text-[10px] text-gray-400 font-sans">{isVideoOff ? 'Video On' : 'Video Off'}</span>
                </button>
              )}
              <button onClick={hangUp} className="flex flex-col items-center space-y-1">
                <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg"><PhoneOff size={28} className="text-white" /></div>
                <span className="text-[10px] text-gray-400 font-sans">End</span>
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // --- MAIN CHAT INTERFACE ---
  return (
    <div className="flex flex-col h-screen bg-cover bg-center bg-fixed text-gray-200 overflow-hidden relative" style={{ backgroundImage: "url('/images/bg-pattern.png')" }} onClick={handleTouch}>
      <AnimatedBackground />

      <header className="relative bg-slate-950/90 backdrop-blur-xl p-3 flex justify-between items-center border-b border-gray-800 shrink-0 z-10">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center overflow-hidden cursor-pointer hover:ring-2 hover:ring-indigo-500 transition-all" onClick={() => profileInputRef.current?.click()}>
            {profilePic ? <img src={profilePic} className="w-full h-full object-cover" alt="Your profile" /> : <User size={16} className="text-white" />}
          </div>
          <input type="file" ref={profileInputRef} onChange={handleProfileUpload} accept="image/*" className="hidden" />
          <div>
            <h1 className="text-white font-bold text-[13px] font-sans">Private Room</h1>
            <p className="text-[10px] text-indigo-400 flex items-center font-mono"><CheckCircle size={8} className="mr-1" /> {roomId}</p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <div className="relative" ref={callMenuRef}>
            <button onClick={() => setShowCallMenu(!showCallMenu)} className="p-2 rounded-full hover:bg-gray-800 transition-all"><MoreVertical size={18} className="text-gray-300" /></button>
            {showCallMenu && (
              <div className="absolute right-0 top-12 bg-slate-900/95 backdrop-blur-xl border border-gray-800 rounded-xl shadow-2xl py-2 w-40 z-50">
                <button onClick={() => startCall('voice')} className="w-full flex items-center space-x-2 px-4 py-2 hover:bg-gray-800 transition-all text-[11px] text-gray-300"><Phone size={14} /><span>Voice Call</span></button>
                <button onClick={() => startCall('video')} className="w-full flex items-center space-x-2 px-4 py-2 hover:bg-gray-800 transition-all text-[11px] text-gray-300"><Video size={14} /><span>Video Call</span></button>
                <div className="border-t border-gray-800 my-1"></div>
                <button onClick={() => copyToClipboard(roomId || '', 'Room ID')} className="w-full flex items-center space-x-2 px-4 py-2 hover:bg-gray-800 transition-all text-[11px] text-gray-300"><Copy size={14} /><span>Copy Room ID</span></button>
                <button onClick={removeProfilePic} className="w-full flex items-center space-x-2 px-4 py-2 hover:bg-gray-800 transition-all text-[11px] text-gray-300"><User size={14} /><span>Remove My Photo</span></button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="relative flex-1 overflow-y-auto p-3 space-y-2 z-10">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 mt-20">
            <p className="text-[13px] font-sans">The vault is empty.</p>
            <p className="text-[10px] mt-1 font-sans">Share the room details to invite someone</p>
          </div>
        )}
        {messages.map((msg) => {
          const isMe = msg.sender === senderId;
          const avatar = isMe ? profilePic : peerProfiles[msg.sender || ''];
          return (
            <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'} items-end space-x-2`}>
              {!isMe && (
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex-shrink-0 overflow-hidden">
                  {avatar ? <img src={avatar} className="w-full h-full object-cover" alt={msg.sender} /> : <User size={12} className="text-white m-auto mt-1.5" />}
                </div>
              )}
              <div className={`max-w-[75%] p-2.5 rounded-2xl ${isMe ? 'bg-gradient-to-r from-indigo-600 to-purple-600 rounded-tr-sm' : 'bg-slate-800/80 backdrop-blur-sm rounded-tl-sm'}`}>
                {!isMe && <p className="text-[9px] text-indigo-400 font-bold mb-0.5 font-sans">{msg.sender}</p>}
                {msg.type === 'audio' ? (
                  <div className="flex items-center space-x-2 bg-black/30 p-2 rounded w-full min-w-[200px]">
                    {decryptedAudios[msg.id] ? (
                      <audio controls src={decryptedAudios[msg.id]} className="w-full h-8 accent-indigo-500" />
                    ) : (
                      <button onClick={() => loadAudio(msg.id, msg.payload)} className="flex items-center space-x-2 text-[12px] text-indigo-400 hover:text-indigo-300 w-full justify-center py-2 transition-colors">
                        <Mic size={14} />
                        <span>Tap to decrypt & play</span>
                      </button>
                    )}
                  </div>
                ) : msg.type === 'image' ? (
                  viewedImages.has(msg.id) ? (
                    <div className="flex items-center space-x-1.5 text-[10px] bg-black/30 p-1.5 rounded text-gray-400"><ImageIcon size={12} /><span>Opened</span></div>
                  ) : (
                    <button onClick={() => openImage(msg.id, msg.payload)} className="flex items-center space-x-1.5 text-[10px] bg-black/30 p-1.5 rounded w-full hover:bg-black/50 text-left"><ImageIcon size={12} className="text-indigo-400" /><span>View Once</span></button>
                  )
                ) : (
                  <p className="break-words text-[12px] leading-tight font-sans">{msg.text}</p>
                )}
              </div>
              {isMe && (
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex-shrink-0 overflow-hidden">
                  {avatar ? <img src={avatar} className="w-full h-full object-cover" alt="You" /> : <User size={12} className="text-white m-auto mt-1.5" />}
                </div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </main>

      {/* --- FOOTER WITH CLEAN RECORDING UI --- */}
      <footer className="relative bg-slate-950/90 backdrop-blur-xl p-2.5 flex items-center border-t border-gray-800 shrink-0 z-10">
        {isRecording ? (
          <div className="flex-1 flex items-center justify-between bg-slate-900/80 rounded-full px-4 py-2 border border-red-500/30 transition-all duration-200 ease-out">
            <button 
              onClick={cancelRecording} 
              className="text-gray-400 hover:text-red-400 p-2 transition-all"
              title="Cancel Recording"
            >
              <X size={20} />
            </button>
            
            <div className="flex flex-col items-center flex-1 mx-2">
              <span className="text-red-400 text-[12px] font-mono mb-1">
                {Math.floor(recordingTime / 60).toString().padStart(2, '0')}:
                {(recordingTime % 60).toString().padStart(2, '0')}
              </span>
              <AudioVisualizer level={audioLevel} />
            </div>

            <button 
              onClick={stopRecording} 
              className="text-gray-400 hover:text-green-400 p-2 transition-all"
              title="Send Voice Note"
            >
              <Check size={24} className="text-green-500" strokeWidth={3} />
            </button>
          </div>
        ) : (
          <>
            <input type="file" ref={fileInputRef} onChange={handleImageUpload} accept="image/*" className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} className="text-gray-400 hover:text-white p-2 transition-all" title="Send Image">
              <ImageIcon size={20} />
            </button>
            <button onClick={startRecording} className="text-gray-400 hover:text-indigo-400 p-2 transition-all" title="Record Voice Note">
              <Mic size={20} />
            </button>
            <input 
              type="text" 
              value={inputText} 
              onChange={(e) => setInputText(e.target.value)} 
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()} 
              placeholder="Type a message..." 
              className="flex-1 bg-slate-900/80 text-white text-[12px] p-2.5 rounded-full outline-none focus:ring-1 focus:ring-indigo-500 font-sans placeholder-gray-500 mx-2" 
            />
            <button onClick={sendMessage} className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white p-2.5 rounded-full transition-all">
              <Send size={18} />
            </button>
          </>
        )}
      </footer>

      {viewingImage && (
        <div className="fixed inset-0 bg-black/95 z-50 flex flex-col items-center justify-center p-4 select-none backdrop-blur-xl" onClick={closeImageViewer}>
          <img src={viewingImage.url} alt="Secret" className="max-w-full max-h-[85vh] object-contain pointer-events-none rounded-lg" onContextMenu={(e) => e.preventDefault()} draggable={false} />
          <p className="absolute bottom-12 text-indigo-400 text-[10px] tracking-widest animate-pulse font-sans">TAP TO DESTROY</p>
        </div>
      )}

      {toast}
      {celebration}
    </div>
  );
}