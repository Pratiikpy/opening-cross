# Opening Bell film

The product film, built with [Remotion](https://www.remotion.dev) in the Opening Bell brand kit (Hanken Grotesk, IBM Plex Mono, ink `#0B0B0F`, accent `#E8430C`, light and dark). Every number on screen comes from `docs/evidence` or a recorded run, and every product screen is a real capture; the one illustration (the opening scene) is labelled as such.

```sh
pnpm install --ignore-workspace
pnpm studio          # preview
pnpm render:1080     # out/opening-bell-1080p.mp4  (about 2:40)
pnpm render:4k       # out/opening-bell-4k.mp4
pnpm render:60       # out/opening-bell-60s.mp4
```

The recorded screens are not committed. Regenerate them at 2x scale from the end-to-end stack (`DSF=2`, see `tests/e2e/run-all.sh` modes `trust`, `flow`, `issuer`, `visual`) into `public/shots/{trust,w3,w4,site}`. Each scene animates from its own normalised progress, so the 60-second cut reuses the same scenes at shorter lengths.
