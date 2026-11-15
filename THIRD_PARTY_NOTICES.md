# Third-party notices

This project's own code is under the MIT License (see `LICENSE`). It ships with, or bundles at
build time, the following third-party software.

## Checked into this repository

| Path | Project | License |
|---|---|---|
| `public/libs/draco/` | [Draco](https://github.com/google/draco) decoder, © Google | Apache-2.0 |
| `public/libs/basis/` | [Basis Universal](https://github.com/BinomialLLC/basis_universal) transcoder, © Binomial LLC | Apache-2.0 |

Both are prebuilt JavaScript / WebAssembly builds of those projects. The Apache License 2.0 text is in
`public/libs/LICENSE-APACHE-2.0.txt`, which is also copied into every build.

## Bundled into the built site (`dist/`)

| Package | License |
|---|---|
| [three.js](https://github.com/mrdoob/three.js) — © three.js authors | MIT |
| [Spark](https://github.com/sparkjsdev/spark) — © World Labs Technologies, Inc. | MIT |

Their full license texts are in `node_modules/<package>/LICENSE` after `npm install`.

## Acknowledgements

The RayNeo head-tracking protocol in `src/headtracking.js` was written from the protocol
descriptions published by the community projects
[HaloneXR/halone](https://github.com/HaloneXR/halone) and
[verncat/RayNeo-Air-3S-Pro-OpenVR](https://github.com/verncat/RayNeo-Air-3S-Pro-OpenVR).

Product names are trademarks of their respective owners. This project is not affiliated with or
endorsed by any glasses manufacturer.
