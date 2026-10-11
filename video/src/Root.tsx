import type { ComponentType } from 'react';
import { AbsoluteFill, Composition, Sequence } from 'remotion';
import { FPS, HEIGHT, WIDTH, fontsReady } from './brand';
import { Authenticity } from './scenes/Authenticity';
import { Close } from './scenes/Close';
import { Cross } from './scenes/Cross';
import { Developers } from './scenes/Developers';
import { Launch } from './scenes/Launch';
import { Premium } from './scenes/Premium';
import { Problem } from './scenes/Problem';
import { Investor, Issuer, TrustScreens } from './scenes/Product';
import { Promises } from './scenes/Promises';
import { Sealed } from './scenes/Sealed';
import { Verifier } from './scenes/Verifier';
import { LastScene, SceneLength } from './ui';

void fontsReady;

type Entry = { id: string; Scene: ComponentType; seconds: number };

const FILM: Entry[] = [
  { id: 'Problem', Scene: Problem, seconds: 10 },
  { id: 'Cross', Scene: Cross, seconds: 16 },
  { id: 'Sealed', Scene: Sealed, seconds: 11 },
  { id: 'Promises', Scene: Promises, seconds: 16 },
  { id: 'Premium', Scene: Premium, seconds: 13 },
  { id: 'Authenticity', Scene: Authenticity, seconds: 14 },
  { id: 'TrustScreens', Scene: TrustScreens, seconds: 11 },
  { id: 'Launch', Scene: Launch, seconds: 14 },
  { id: 'Verifier', Scene: Verifier, seconds: 12 },
  { id: 'Developers', Scene: Developers, seconds: 12 },
  { id: 'Investor', Scene: Investor, seconds: 13 },
  { id: 'Issuer', Scene: Issuer, seconds: 9 },
  { id: 'Close', Scene: Close, seconds: 9 },
];

// The sixty-second cut: the same scenes, shorter, because each one animates from its own normalised progress.
const SHORT: Entry[] = [
  { id: 'Problem', Scene: Problem, seconds: 6 },
  { id: 'Cross', Scene: Cross, seconds: 10 },
  { id: 'Promises', Scene: Promises, seconds: 10 },
  { id: 'Premium', Scene: Premium, seconds: 8 },
  { id: 'Authenticity', Scene: Authenticity, seconds: 9 },
  { id: 'Verifier', Scene: Verifier, seconds: 8 },
  { id: 'Close', Scene: Close, seconds: 9 },
];

const frames = (e: Entry[]) => e.reduce((n, x) => n + Math.round(x.seconds * FPS), 0);

const OVERLAP = 10;

// Each scene starts OVERLAP frames before the previous one ends and fades in over it, so the cut is a dissolve and
// never dips to black. The slots still add up to the timeline's nominal length.
function Timeline({ entries }: { entries: Entry[] }) {
  let at = 0;
  return (
    <AbsoluteFill style={{ background: '#0b0b0f' }}>
      {entries.map((e, i) => {
        const nominal = Math.round(e.seconds * FPS);
        const from = at - (i > 0 ? OVERLAP : 0);
        const d = nominal + (i > 0 ? OVERLAP : 0);
        at += nominal;
        return (
          <Sequence key={e.id} from={from} durationInFrames={d} name={e.id}>
            <LastScene.Provider value={i === entries.length - 1}>
              <SceneLength.Provider value={d}>
                <e.Scene />
              </SceneLength.Provider>
            </LastScene.Provider>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

export function Root() {
  return (
    <>
      <Composition id="Film" component={() => <Timeline entries={FILM} />} durationInFrames={frames(FILM)} fps={FPS} width={WIDTH} height={HEIGHT} />
      <Composition id="Short" component={() => <Timeline entries={SHORT} />} durationInFrames={frames(SHORT)} fps={FPS} width={WIDTH} height={HEIGHT} />
      {FILM.map((e) => (
        <Composition key={e.id} id={e.id} component={e.Scene} durationInFrames={Math.round(e.seconds * FPS)} fps={FPS} width={WIDTH} height={HEIGHT} />
      ))}
    </>
  );
}
