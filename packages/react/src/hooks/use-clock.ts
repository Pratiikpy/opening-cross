import { useEffect, useState } from 'react';

/** Unix seconds, ticking once a second, shifted by `offsetSeconds` (the cluster's clock minus this machine's, when it is known). */
export function useClock(offsetSeconds = 0n, tickMs = 1000): bigint {
  const read = () => BigInt(Math.floor(Date.now() / 1000)) + offsetSeconds;
  const [now, setNow] = useState(read);
  useEffect(() => {
    setNow(read());
    const t = setInterval(() => setNow(read()), tickMs);
    return () => clearInterval(t);
    // `read` closes over the offset only.
  }, [offsetSeconds, tickMs]);
  return now;
}
