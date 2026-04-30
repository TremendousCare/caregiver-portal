import { useCallback, useEffect, useRef, useState } from 'react';

const SpeechRecognitionAPI = typeof window !== 'undefined'
  ? window.SpeechRecognition || window.webkitSpeechRecognition
  : null;

/**
 * Browser Web Speech API wrapper. Streams interim transcripts into
 * `onTranscript` while the mic is active. Auto-stops on unmount.
 *
 * Returns null `supported` if the browser has no SpeechRecognition.
 * UI should hide the mic button in that case.
 */
export function useSpeechRecognition({ onTranscript, lang = 'en-US' } = {}) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) recognitionRef.current.stop();
    };
  }, []);

  const stop = useCallback(() => {
    if (recognitionRef.current) recognitionRef.current.stop();
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (!SpeechRecognitionAPI) return;
    if (listening) {
      stop();
      return;
    }
    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      if (typeof onTranscriptRef.current === 'function') {
        onTranscriptRef.current(transcript);
      }
    };

    recognition.onerror = (event) => {
      console.warn('Speech recognition error:', event.error);
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening, lang, stop]);

  return {
    supported: !!SpeechRecognitionAPI,
    listening,
    toggle,
    stop,
  };
}
