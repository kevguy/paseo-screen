// useRpc bound to the host of the mounted screen, like Paseo's.
import { createContext, createElement, useCallback, useContext } from "react";
const Host = createContext(null);
export const HostRpc = ({ call, children }) => createElement(Host.Provider, { value: call }, children);
export function useRpc(contract) {
  const call = useContext(Host);
  return useCallback((input) => call(contract.name, input), [call, contract]);
}
