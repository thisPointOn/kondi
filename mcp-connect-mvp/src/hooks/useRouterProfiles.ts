/**
 * Subscribe a component to router-profile changes (add/edit/remove in
 * Settings → Routing). Returns a version number that bumps on every change so
 * selectors can recompute their routed-model lists via getRoutedProfileOptions().
 */
import { useSyncExternalStore } from 'react';
import { ROUTER_PROFILES_EVENT, getStoreVersion } from '../router/profile-store';

const subscribe = (cb: () => void) => {
  window.addEventListener(ROUTER_PROFILES_EVENT, cb);
  return () => window.removeEventListener(ROUTER_PROFILES_EVENT, cb);
};

export function useRouterProfilesVersion(): number {
  return useSyncExternalStore(subscribe, getStoreVersion, getStoreVersion);
}
