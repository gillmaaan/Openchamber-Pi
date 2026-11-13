import React from 'react';

import { supportsDesktopSidebarVibrancy } from '@/lib/desktop';
import { setDesktopSidebarVibrancy } from '@/lib/desktopNative';
import { useUIStore } from '@/stores/useUIStore';

const ATTRIBUTE = 'data-oc-sidebar-vibrancy';
const OPACITY_PROPERTY = '--oc-sidebar-opacity';

/**
 * macOS desktop only: keeps the window's material and the page's translucent
 * sidebar in step with the Appearance setting. The page makes the sidebar
 * translucent only after the shell confirms the window shows the material, so
 * a refused request never leaves a sidebar over a flat window colour.
 */
export const useDesktopSidebarVibrancy = (): void => {
  const translucent = useUIStore((state) => state.desktopSidebarTranslucent);
  const opacity = useUIStore((state) => state.desktopSidebarOpacity);
  const [active, setActive] = React.useState(false);

  React.useEffect(() => {
    if (!supportsDesktopSidebarVibrancy()) return undefined;
    let cancelled = false;
    // Off first on the page, so no translucent sidebar is drawn over the flat
    // colour the window takes on once the shell drops the material.
    if (!translucent) setActive(false);
    void setDesktopSidebarVibrancy(translucent).then((applied) => {
      if (!cancelled) setActive(translucent && applied);
    });
    return () => {
      cancelled = true;
    };
  }, [translucent]);

  React.useEffect(() => {
    if (!active) return undefined;
    const root = document.documentElement;
    root.setAttribute(ATTRIBUTE, '');
    root.style.setProperty(OPACITY_PROPERTY, `${opacity}%`);
    return () => {
      root.removeAttribute(ATTRIBUTE);
      root.style.removeProperty(OPACITY_PROPERTY);
    };
  }, [active, opacity]);
};
