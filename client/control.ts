import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { controlStateRpc, setControlPausedRpc } from "../shared/rpc";

/**
 * The host-wide remote control pause, shared by the sidebar row and the viewer. Polling it is cheap:
 * the host reads a small preferences file and does not start the screen helper.
 */
export function useControlPause(hostId: string) {
  const readState = useRpc(controlStateRpc);
  const setPaused = useRpc(setControlPausedRpc);
  const queryClient = useQueryClient();
  const queryKey = ["paseo-screen", "control", hostId];
  const state = useQuery({ queryKey, queryFn: () => readState({}), refetchInterval: 5000 });
  const change = useMutation({
    mutationFn: (paused: boolean) => setPaused({ paused }),
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
  });
  return {
    /** Unknown until the first reply; treat as not paused so nothing flashes. */
    paused: state.data?.paused === true,
    known: state.data !== undefined,
    changing: change.isPending,
    setPaused: (paused: boolean) => change.mutate(paused),
  };
}
