import React from 'react';

type Args = {
  enabled?: boolean;
  isSessionSearchOpen: boolean;
  openSessionSearch: () => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
};

const focusField = (ref: React.RefObject<HTMLInputElement | null>) => {
  ref.current?.focus();
  ref.current?.select();
};

export const useSessionSearchEffects = ({
  enabled = true,
  isSessionSearchOpen,
  openSessionSearch,
  sessionSearchInputRef,
}: Args): void => {
  // The field opens in place of the Search row, so the caret goes into it.
  React.useEffect(() => {
    if (!enabled || !isSessionSearchOpen || typeof window === 'undefined') {
      return;
    }
    const raf = window.requestAnimationFrame(() => focusField(sessionSearchInputRef));
    return () => window.cancelAnimationFrame(raf);
  }, [enabled, isSessionSearchOpen, sessionSearchInputRef]);

  // The open_session_list shortcut lands here when the sidebar is visible:
  // the session list is already on screen, so the shortcut opens its search.
  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }
    const handleOpenRequest = () => {
      openSessionSearch();
      focusField(sessionSearchInputRef);
    };
    window.addEventListener('openchamber:sidebar-session-search', handleOpenRequest);
    return () => window.removeEventListener('openchamber:sidebar-session-search', handleOpenRequest);
  }, [enabled, openSessionSearch, sessionSearchInputRef]);
};
