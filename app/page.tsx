// app/page.tsx
'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { MediaConnection } from 'peerjs';
import { generateKey, exportKeyToBase64, importKeyFromBase64, encryptText, decryptText } from '@/lib/crypto';
import { Phone, Video, PhoneOff, Mic, MicOff, VideoOff, User, CheckCircle, Image as ImageIcon, Send, Lock, MessageCircle, MoreVertical, Copy, Volume2, AlertCircle, X, Check } from 'lucide-react';

// --- Sound Effects System ---
const playSound = (type: 'load' | 'send' | 'receive' | 'call') => {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    if (type === 'load') {
      oscillator.frequency.setValueAtTime(523.25, audioContext.currentTime);
      oscillator.frequency.setValueAtTime(659.25, audioContext.currentTime + 0.1);
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
    } else if (type === 'send') {
      oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.05, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);
    } else if (type === 'receive') {
      oscillator.frequency.setValueAtTime(1046.5, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.05, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.15);
    } else if (type === 'call') {
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);
    }
  } catch (e) { console.error('Audio error:', e); }
};

// --- LocalStorage Helpers ---
const saveProfileToStorage = (profileBase64: string) => {
  if (typeof window !== 'undefined') localStorage.setItem('secretChat_profile', profileBase64);
};
const loadProfileFromStorage = (): string | null => {
  if (typeof window !== 'undefined') return localStorage.getItem('secretChat_profile');
  return null;
};
const clearProfileFromStorage = () => {
  if (typeof window !== 'undefined') localStorage.removeItem('secretChat_profile');
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

// --- Per-tab, per-room sender id ---
const getOrCreateSenderId = (roomKey: string): string => {
  if (typeof window === 'undefined') return `User_${Math.random().toString(36).substring(2, 7)}`;
  const storageKey = `secretChat_sender_${roomKey}`;
  const existing = sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const fresh = `User_${Math.random().toString(36).substring(2, 7)}`;
  sessionStorage.setItem(storageKey, fresh);
  return fresh;
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

// --- Audio Visualizer Component ---
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

export default function SecretChat() {
  // --- Refs ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const profileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const myPeerIdRef = useRef<string | null>(null);
  const peerInstance = useRef<Peer | null>(null);
  const currentCall = useRef<MediaConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimeoutRef = useRef<any>(null);
  const animationRef = useRef<number>(0);
  const callMenuRef = useRef<HTMLDivElement>(null);
  
  // Voice Note Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  
  const profilePicRef = useRef<string>('');

  // --- Core State ---
  const [roomId, setRoomId] = useState<string | null>(null);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [roomKeyBase64, setRoomKeyBase64] = useState<string>('');
  const [isJoined, setIsJoined] = useState(false);
  const [messages, setMessages] = useState<any[]>([]);
  const [inputText, setInputText] = useState('');
  const [viewingImage, setViewingImage] = useState<{ url: string; id: string } | null>(null);
  const [viewedImages, setViewedImages] = useState<Set<string>>(new Set());
  const [senderId, setSenderId] = useState<string>('');
  const [profilePic, setProfilePic] = useState<string>('');
  const [peerProfiles, setPeerProfiles] = useState<Record<string, string>>({});
  const [decryptedAudios, setDecryptedAudios] = useState<Record<string, string>>({});

  // --- Call State ---
  const [remotePeerId, setRemotePeerId] = useState<string | null>(null);
  const [callState, setCallState] = useState<'idle' | 'outgoing' | 'incoming' | 'connected' | 'declined' | 'failed'>('idle');
  const [callType, setCallType] = useState<'voice' | 'video'>('video');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [incomingCallData, setIncomingCallData] = useState<{ call: MediaConnection; type: 'voice' | 'video'; callerId: string } | null>(null);
  const [connectionStatus, setConnectionStatus] = useState('Initializing...');
  const [callError, setCallError] = useState<string | null>(null);
  const [webrtcConnectionState, setWebrtcConnectionState] = useState<string>('new');

  // --- Voice Note State ---
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);

  const callStateRef = useRef(callState);
  useEffect(() => { callStateRef.current = callState; }, [callState]);

  // --- UI State ---
  const [showLanding, setShowLanding] = useState(true);
  const [joinRoomId, setJoinRoomId] = useState('');
  const [joinRoomKey, setJoinRoomKey] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [showContent, setShowContent] = useState(false);
  const [showRoomDetails, setShowRoomDetails] = useState(false);
  const [showCallMenu, setShowCallMenu] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [animationPhase, setAnimationPhase] = useState(0);

  const intervalRef = useRef<any>(null);

  // Load saved profile
  useEffect(() => {
    const savedProfile = loadProfileFromStorage();
    if (savedProfile) {
      setProfilePic(savedProfile);
      profilePicRef.current = savedProfile;
    }
  }, []);

  useEffect(() => {
    profilePicRef.current = profilePic;
  }, [profilePic]);

  useEffect(() => {
    playSound('load');
    const timer = setTimeout(() => {
      setIsLoading(false);
      setTimeout(() => setShowContent(true), 300);
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (isJoined && initialLoad && roomId) {
      const loadTimer = setTimeout(() => setInitialLoad(false), 30000);
      return () => clearTimeout(loadTimer);
    }
  }, [isJoined, initialLoad, roomId]);

  useEffect(() => {
    const animate = () => {
      setAnimationPhase((prev) => (prev + 1) % 360);
      animationRef.current = requestAnimationFrame(animate);
    };
    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
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

  const cleanupRecording = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (currentCall.current) currentCall.current.close();
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach((t) => t.stop());
      if (peerInstance.current) peerInstance.current.destroy();
      if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
      cleanupRecording();
    };
  }, [cleanupRecording]);

  useEffect(() => {
    const { room: urlRoom, key: urlKey } = readRoomAndKeyFromLocation();
    if (urlRoom && urlKey) {
      setShowLanding(false);
      setRoomId(urlRoom);
      setSenderId(getOrCreateSenderId(urlRoom));
      importKeyFromBase64(decodeURIComponent(urlKey) as string)
        .then((key) => {
          setCryptoKey(key);
          setRoomKeyBase64(urlKey);
          setIsJoined(true);
          setInitialLoad(false);
          setConnectionStatus('Connecting to Secure Network...');
          setTimeout(() => initializePeer(), 500);
        })
        .catch((err) => console.error('Key import failed', err));
    }
  }, []);

  const initializePeer = () => {
    if (peerInstance.current) return;

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

    const peer = new Peer(undefined, {
      host: '0.peerjs.com',
      port: 443,
      secure: true,
      debug: 2,
      config: { iceServers, iceCandidatePoolSize: 10 },
    });

    peer.on('open', (id) => {
      myPeerIdRef.current = id;
      setConnectionStatus('Network Connected. Waiting for peer...');
      sendSystemMessage(`__SYS_PEER__:${id}`);
    });

    peer.on('call', (call) => {
      if (callStateRef.current !== 'idle') { call.close(); return; }
      const type = call.metadata?.type || 'video';
      const callerId = call.metadata?.callerId || 'Unknown';
      setIncomingCallData({ call, type, callerId });
      setCallType(type);
      setCallState('incoming');
      playSound('call');

      if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = setTimeout(() => {
        if (callStateRef.current === 'incoming') declineCall();
      }, 30000);
    });

    peer.on('disconnected', () => {
      setConnectionStatus('Reconnecting...');
      setTimeout(() => peer.reconnect(), 2000);
    });

    peer.on('error', (err) => {
      console.error('PeerJS Error:', err);
      setConnectionStatus('Network Error');
    });

    peerInstance.current = peer;
  };

  const createRoom = async () => {
    const newRoomId = generateRoomId();
    const key = await generateKey() as CryptoKey; // FIX: Explicit type assertion
    const rawExportedKey = await exportKeyToBase64(key);
    const encodedKey = encodeURIComponent(rawExportedKey as string); // FIX: Explicit type assertion

    setRoomId(newRoomId);
    setCryptoKey(key);
    setRoomKeyBase64(encodedKey);
    setSenderId(getOrCreateSenderId(newRoomId));
    setIsJoined(true);
    setShowLanding(false);
    setShowRoomDetails(true);
    window.history.pushState({}, '', `${window.location.pathname}#room=${newRoomId}&key=${encodedKey}`);
    setTimeout(() => initializePeer(), 500);
  };

  const joinRoom = async () => {
    if (!joinRoomId.trim() || !joinRoomKey.trim()) {
      setCallError('Please enter both Room ID and Secret Key');
      return;
    }
    const normalizedRoomId = joinRoomId.toUpperCase();
    importKeyFromBase64(decodeURIComponent(joinRoomKey) as string) // FIX: Explicit type assertion
      .then((key) => {
        setRoomId(normalizedRoomId);
        setCryptoKey(key);
        setRoomKeyBase64(joinRoomKey);
        setSenderId(getOrCreateSenderId(normalizedRoomId));
        setIsJoined(true);
        setInitialLoad(false);
        setShowLanding(false);
        setConnectionStatus('Connecting...');
        window.history.pushState({}, '', `${window.location.pathname}#room=${normalizedRoomId}&key=${encodeURIComponent(joinRoomKey)}`);
        setTimeout(() => initializePeer(), 500);
      })
      .catch((err) => {
        setCallError('Invalid Secret Key. Please check and try again.');
        console.error('Key import failed', err);
      });
  };

  // --- POLLING ENGINE ---
  useEffect(() => {
    if (!isJoined || !roomId || !cryptoKey) return;
    let lastMessageCount = 0;

    const fetchMessages = async () => {
      try {
        const res = await fetch(`/api/message?roomId=${roomId}`);
        const data = await res.json();
        if (data.success) {
          const decryptedMsgs = await Promise.all(
            data.messages.map(async (msg: any) => {
              try {
                const text = await decryptText(msg.payload, cryptoKey as CryptoKey);
                if (msg.type === 'system') {
                  if (text.startsWith('__SYS_PEER__:')) {
                    const pId = text.split('__SYS_PEER__:')[1];
                    if (pId !== myPeerIdRef.current) {
                      setRemotePeerId(pId);
                      setConnectionStatus('Peer Connected & Encrypted');
                      sendSystemMessage('__SYS_REQUEST_PROFILES__');
                    }
                    return null;
                  }
                  if (text === '__SYS_REQUEST_PROFILES__') {
                    if (profilePicRef.current) {
                      sendSystemMessage(`__SYS_PROFILE__::${senderId}::${profilePicRef.current}`);
                    }
                    return null;
                  }
                  if (text.startsWith('__SYS_PROFILE__::')) {
                    const payload = text.substring('__SYS_PROFILE__::'.length);
                    const firstColonIndex = payload.indexOf('::');
                    if (firstColonIndex !== -1) {
                      const pSender = payload.substring(0, firstColonIndex);
                      const pBase64 = payload.substring(firstColonIndex + 2);
                      setPeerProfiles((prev) => ({ ...prev, [pSender]: pBase64 }));
                    }
                    return null;
                  }
                  if (text === '__SYS_CALL_DECLINED__') {
                    setCallState('declined');
                    setTimeout(() => setCallState('idle'), 3000);
                    return null;
                  }
                }
                return { ...msg, text };
              } catch { return { ...msg, text: '[Error]' }; }
            })
          );
          const validMsgs = decryptedMsgs.filter((m) => m !== null);
          validMsgs.sort((a, b) => Number(a.id) - Number(b.id));
          if (validMsgs.length > lastMessageCount && lastMessageCount > 0) playSound('receive');
          lastMessageCount = validMsgs.length;
          setMessages(validMsgs);
        }
      } catch (err) { console.error('Failed to fetch messages', err); }
    };

    fetchMessages();
    intervalRef.current = setInterval(fetchMessages, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isJoined, roomId, cryptoKey, senderId]);

  const sendSystemMessage = async (text: string) => {
    if (!cryptoKey || !roomId) return;
    const messageId = Date.now().toString();
    const encryptedPayload = await encryptText(text, cryptoKey as CryptoKey);
    await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, messageId, encryptedPayload, senderId: 'SYSTEM', type: 'system' }),
    });
  };

  const sendMessage = async () => {
    if (!inputText.trim() || !cryptoKey || !roomId) return;
    const messageId = Date.now().toString();
    const encryptedPayload = await encryptText(inputText, cryptoKey as CryptoKey);
    await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, messageId, encryptedPayload, senderId, type: 'text' }),
    });
    setInputText('');
    playSound('send');
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCallError(`${label} copied!`);
    setTimeout(() => setCallError(null), 2000);
  };

  // --- VOICE NOTE FUNCTIONS ---
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyserRef.current = analyser;
      analyser.fftSize = 256;
      
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      
      const updateVisualizer = () => {
        if (!analyserRef.current) return;
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);
        
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        const volume = Math.min(100, Math.max(0, (average / 255) * 100 * 2.5)); 
        
        setAudioLevel(volume);
        animationFrameRef.current = requestAnimationFrame(updateVisualizer);
      };
      updateVisualizer();

      const options = MediaRecorder.isTypeSupported('audio/webm') ? { mimeType: 'audio/webm' } : {};
      mediaRecorderRef.current = new MediaRecorder(stream, options);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' });
        if (audioBlob.size > 0) {
          await sendVoiceNote(audioBlob);
        }
        cleanupRecording();
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      setRecordingTime(0);
      
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => {
          if (prev >= 59) {
            stopRecording();
            return 60;
          }
          return prev + 1;
        });
      }, 1000);

    } catch (err: any) {
      console.error("Microphone access denied:", err);
      setCallError("Microphone access denied. Please check browser permissions.");
      setTimeout(() => setCallError(null), 3000);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setAudioLevel(0);
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setAudioLevel(0);
      audioChunksRef.current = [];
      cleanupRecording();
    }
  };

  const sendVoiceNote = async (audioBlob: Blob) => {
    if (!cryptoKey || !roomId) return;
    try {
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);
      reader.onloadend = async () => {
        const base64Audio = reader.result as string;
        const messageId = Date.now().toString();
        const encryptedPayload = await encryptText(base64Audio, cryptoKey as CryptoKey);
        
        await fetch('/api/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId, messageId, encryptedPayload, senderId, type: 'audio' }),
        });
        playSound('send');
      };
    } catch (error) {
      console.error("Voice note failed", error);
    }
  };

  const loadAudio = async (msgId: string, encryptedBase64: string) => {
    if (decryptedAudios[msgId] || !cryptoKey) return;
    try {
      const decryptedDataUrl = await decryptText(encryptedBase64, cryptoKey as CryptoKey);
      setDecryptedAudios(prev => ({ ...prev, [msgId]: decryptedDataUrl }));
    } catch (error) {
      console.error("Audio decrypt failed", error);
    }
  };

  // --- CALL FUNCTIONS ---
  const startCall = async (type: 'voice' | 'video') => {
    if (!remotePeerId || !peerInstance.current) {
      setCallError('Waiting for peer to join the room first...');
      setTimeout(() => setCallError(null), 3000);
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
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const call = peerInstance.current.call(remotePeerId, stream, { metadata: { type, callerId: senderId } });
      currentCall.current = call;

      const pc = (call as any).peerConnection;
      if (pc) {
        pc.addEventListener('connectionstatechange', () => {
          setWebrtcConnectionState(pc.connectionState);
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setCallError('Connection degraded. Reconnecting...');
          } else if (pc.connectionState === 'connected') {
            setCallError(null);
          }
        });
      }

      if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = setTimeout(() => {
        if (callStateRef.current === 'outgoing') {
          setCallError('Call timed out. No answer.');
          setCallState('failed');
          endCall();
        }
      }, 15000);

      call.on('stream', (remoteStream) => {
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
        setCallState('connected');
        if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
      });

      call.on('close', () => endCall());
      call.on('error', () => {
        setCallError('Call failed. Please try again.');
        setCallState('failed');
        endCall();
      });
    } catch (err: any) {
      setCallError(`Camera/Mic blocked: ${err.message}. Ensure you are on HTTPS or localhost.`);
      endCall();
    }
  };

  const acceptCall = async () => {
    if (!incomingCallData) return;
    const { call, type } = incomingCallData;
    setCallType(type);
    setCallError(null);

    if (callTimeoutRef.current) { clearTimeout(callTimeoutRef.current); callTimeoutRef.current = null; }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: type === 'video', audio: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      call.answer(stream);
      currentCall.current = call;

      const pc = (call as any).peerConnection;
      if (pc) {
        pc.addEventListener('connectionstatechange', () => {
          setWebrtcConnectionState(pc.connectionState);
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setCallError('Connection degraded. Reconnecting...');
          } else if (pc.connectionState === 'connected') {
            setCallError(null);
          }
        });
      }

      call.on('stream', (remoteStream) => {
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
        setCallState('connected');
      });
      call.on('close', () => endCall());
      call.on('error', () => {
        setCallError('Call failed. Please try again.');
        setCallState('failed');
        endCall();
      });

      setIncomingCallData(null);
    } catch (err: any) {
      setCallError(`Camera/Mic blocked: ${err.message}. Check browser settings.`);
      declineCall();
    }
  };

  const declineCall = () => {
    if (callTimeoutRef.current) { clearTimeout(callTimeoutRef.current); callTimeoutRef.current = null; }
    if (incomingCallData) {
      incomingCallData.call.close();
      sendSystemMessage('__SYS_CALL_DECLINED__');
      setIncomingCallData(null);
    }
    setCallState('idle');
    setCallError(null);
  };

  const endCall = () => {
    if (callTimeoutRef.current) { clearTimeout(callTimeoutRef.current); callTimeoutRef.current = null; }
    if (currentCall.current) { currentCall.current.close(); currentCall.current = null; }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    setCallState('idle');
    setIncomingCallData(null);
    setIsMuted(false);
    setIsVideoOff(false);
    setCallError(null);
    setWebrtcConnectionState('new');
  };

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const audioTracks = localStreamRef.current.getAudioTracks();
    const nextMuted = !isMuted;
    audioTracks.forEach((track) => { track.enabled = !nextMuted; });
    setIsMuted(nextMuted);
  }, [isMuted]);

  const toggleVideo = useCallback(() => {
    if (!localStreamRef.current) return;
    const videoTracks = localStreamRef.current.getVideoTracks();
    const nextOff = !isVideoOff;
    videoTracks.forEach((track) => { track.enabled = !nextOff; });
    setIsVideoOff(nextOff);
  }, [isVideoOff]);

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
          if (!ctx) return reject('Canvas failed');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
      };
      reader.onerror = reject;
    });
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !cryptoKey || !roomId) return;
    try {
      const compressed = await compressImage(file, 800, 0.6);
      const messageId = Date.now().toString();
      const encryptedPayload = await encryptText(compressed, cryptoKey as CryptoKey);
      await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, messageId, encryptedPayload, senderId, type: 'image' }),
      });
      playSound('send');
    } catch (error) { console.error('Image failed', error); }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleProfileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImage(file, 100, 0.5);
      setProfilePic(compressed);
      saveProfileToStorage(compressed);
      if (cryptoKey && roomId) {
        await sendSystemMessage(`__SYS_PROFILE__::${senderId}::${compressed}`);
      }
    } catch (error) { console.error('Profile failed', error); }
    if (profileInputRef.current) profileInputRef.current.value = '';
  };

  const removeProfilePic = () => {
    setProfilePic('');
    clearProfileFromStorage();
  };

  const openImage = async (msgId: string, encryptedBase64: string) => {
    if (!cryptoKey || viewedImages.has(msgId)) return;
    try {
      const decryptedDataUrl = await decryptText(encryptedBase64, cryptoKey as CryptoKey);
      setViewingImage({ url: decryptedDataUrl, id: msgId });
    } catch (error) { console.error('Decrypt failed', error); }
  };

  const closeImageViewer = () => {
    if (viewingImage) {
      const id = viewingImage.id;
      setViewedImages((prev) => new Set(prev).add(id));
      setViewingImage(null);
      fetch(`/api/message?roomId=${roomId}&messageId=${id}`, { method: 'DELETE' }).catch(() => {});
    }
  };

  const handleTouch = (e: React.MouseEvent | React.TouchEvent) => {
    const touch = 'touches' in e ? e.touches[0] : e;
    const ripple = document.createElement('div');
    ripple.className = 'fixed w-32 h-32 bg-white/20 rounded-full pointer-events-none animate-ping z-50';
    ripple.style.left = `${touch.clientX - 64}px`;
    ripple.style.top = `${touch.clientY - 64}px`;
    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 1000);
  };

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

  // --- 30-SECOND INITIAL LOAD ---
  if (isJoined && initialLoad) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex flex-col items-center justify-center" onClick={handleTouch}>
        <div className="text-center space-y-6">
          <div className="relative w-20 h-20 mx-auto">
            <div className="absolute inset-0 border-4 border-indigo-500/30 rounded-full animate-pulse"></div>
            <div className="absolute inset-0 border-t-4 border-indigo-400 rounded-full animate-spin"></div>
            <div className="absolute inset-4 bg-gradient-to-br from-indigo-600 to-purple-600 rounded-full flex items-center justify-center">
              <Lock className="w-8 h-8 text-white" />
            </div>
          </div>
          <div>
            <h2 className="text-xl font-bold text-white mb-2 font-sans">Establishing Secure Connection</h2>
            <p className="text-indigo-300 text-xs font-sans">Initializing encryption protocols...</p>
            <p className="text-gray-500 text-xs mt-2 font-mono">Room: {roomId}</p>
          </div>
          <div className="w-64 h-1 bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 animate-pulse w-full"></div>
          </div>
        </div>
      </div>
    );
  }

  // --- LANDING PAGE ---
  if (showLanding) {
    return (
      <div className={`min-h-screen bg-cover bg-center bg-fixed transition-opacity duration-700 ${showContent ? 'opacity-100' : 'opacity-0'}`} style={{ backgroundImage: "url('/images/bg-pattern.png')" }} onClick={handleTouch}>
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
    );
  }

  // --- INCOMING CALL MODAL ---
  if (callState === 'incoming' && incomingCallData) {
    return (
      <div className="fixed inset-0 z-50 bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex flex-col items-center justify-between py-24 px-4" onClick={handleTouch}>
        <div className="flex flex-col items-center space-y-6">
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center overflow-hidden border-4 border-white/20 shadow-2xl animate-pulse">
            {peerProfiles[incomingCallData.callerId] ? <img src={peerProfiles[incomingCallData.callerId]} className="w-full h-full object-cover" /> : <User size={64} className="text-white" />}
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
          {callType === 'video' && callState === 'connected' ? (
            <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
          ) : (
            <div className="flex flex-col items-center space-y-6">
              <div className="w-40 h-40 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center overflow-hidden border-4 border-white/20 shadow-2xl">
                {remotePeerId && peerProfiles[remotePeerId] ? <img src={peerProfiles[remotePeerId]} className="w-full h-full object-cover" /> : <User size={80} className="text-white" />}
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
          {(callType === 'video' || !isVideoOff) && callState === 'connected' && (
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
              <button onClick={endCall} className="flex flex-col items-center space-y-1">
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
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-950/40 via-purple-950/40 to-slate-950/40" style={{ background: `linear-gradient(${animationPhase}deg, rgba(99, 102, 241, 0.3) 0%, rgba(168, 85, 247, 0.3) 50%, rgba(15, 23, 42, 0.4) 100%)` }}></div>
        <div className="absolute inset-0 bg-gradient-to-bl from-purple-950/30 via-transparent to-indigo-950/30" style={{ opacity: Math.sin((animationPhase * Math.PI) / 180) * 0.5 + 0.5, transform: `rotate(${animationPhase}deg)` }}></div>
      </div>

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
          const avatar = isMe ? profilePic : peerProfiles[msg.sender];
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
    </div>
  );
}