import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

const STORAGE_KEY = 'oci.temporaryChat';

interface TemporaryChatContextValue {
  temporary: boolean;
  setTemporary: (value: boolean) => void;
}

const TemporaryChatContext = createContext<TemporaryChatContextValue | null>(null);

export function TemporaryChatProvider({ children }: { children: ReactNode }) {
  const [temporary, setTemporaryState] = useState(
    () => sessionStorage.getItem(STORAGE_KEY) === 'true',
  );

  const setTemporary = useCallback((value: boolean) => {
    setTemporaryState(value);
    if (value) sessionStorage.setItem(STORAGE_KEY, 'true');
    else sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  return (
    <TemporaryChatContext.Provider value={{ temporary, setTemporary }}>
      {children}
    </TemporaryChatContext.Provider>
  );
}

export function useTemporaryChat() {
  const value = useContext(TemporaryChatContext);
  if (!value) throw new Error('useTemporaryChat must be used within TemporaryChatProvider');
  return value;
}
