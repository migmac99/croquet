# Graph Report - .  (2026-06-23)

## Corpus Check
- 146 files · ~1,475,823 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 5443 nodes · 10974 edges · 52 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `Controller` - 90 edges
2. `Controller` - 90 edges
3. `Controller` - 90 edges
4. `Controller` - 90 edges
5. `Controller` - 90 edges
6. `YouTubePlayerView` - 81 edges
7. `VirtualMachine` - 59 edges
8. `VirtualMachine` - 59 edges
9. `VirtualMachine` - 59 edges
10. `VirtualMachine` - 59 edges

## Surprising Connections (you probably didn't know these)
- `fetch()` --calls--> `verifyAccountSecret()`  [EXTRACTED]
  workers/synchronizer/src/index.ts → workers/manager/src/index.ts
- `fetch()` --calls--> `getPrometheusMetrics()`  [EXTRACTED]
  workers/synchronizer/src/index.ts → workers/manager/src/index.ts
- `fetch()` --calls--> `verifyAccessJWT()`  [EXTRACTED]
  workers/synchronizer/src/index.ts → workers/manager/src/index.ts
- `fetch()` --calls--> `json()`  [EXTRACTED]
  workers/synchronizer/src/index.ts → workers/manager/src/index.ts
- `fetch()` --calls--> `error()`  [EXTRACTED]
  workers/synchronizer/src/index.ts → workers/manager/src/index.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.01
Nodes (210): abs(), addClassHash(), addConstantsHash(), addSpinnerStyle(), addToastifyStyle(), addWidgetStyle(), allClasses(), allClassTypes() (+202 more)

### Community 1 - "Community 1"
Cohesion: 0.01
Nodes (210): abs(), addClassHash(), addConstantsHash(), addSpinnerStyle(), addToastifyStyle(), addWidgetStyle(), allClasses(), allClassTypes() (+202 more)

### Community 2 - "Community 2"
Cohesion: 0.01
Nodes (207): abs(), addClassHash(), addConstantsHash(), addSpinnerStyle(), addToastifyStyle(), addWidgetStyle(), allClasses(), allClassTypes() (+199 more)

### Community 3 - "Community 3"
Cohesion: 0.01
Nodes (181): abs(), addClassHash(), addConstantsHash(), allClasses(), allClassTypes(), arrayBufferToBase64(), asQFuncSubscription(), bi_flush() (+173 more)

### Community 4 - "Community 4"
Cohesion: 0.01
Nodes (423): a_(), a2(), a3(), Aa(), Ab(), activeSubscription(), activity(), addGenericSubscription() (+415 more)

### Community 5 - "Community 5"
Cohesion: 0.01
Nodes (413): a_(), a2(), a4(), aa(), activeSubscription(), activity(), addGenericSubscription(), addHasher() (+405 more)

### Community 6 - "Community 6"
Cohesion: 0.02
Nodes (81): ChatModel, ChatView, ChatModel, getNewValue(), isFunction(), createAccount(), createApiKey(), deleteAccount() (+73 more)

### Community 7 - "Community 7"
Cohesion: 0.02
Nodes (31): PriorityQueue, arrayBufferToBase64(), asQFuncSubscription(), clearPersistenceCache(), compileQFunc(), createQFunc(), CroquetWarning, decode() (+23 more)

### Community 8 - "Community 8"
Cohesion: 0.03
Nodes (8): Connection, Controller, initDEPIN(), initOptions(), logVersion(), randomString(), setDebug(), OfflineSocket

### Community 9 - "Community 9"
Cohesion: 0.03
Nodes (30): Data, DataHandle, debug(), fromBase64Url(), hashFromUrl(), scramble(), toBase64Url(), addClassHash() (+22 more)

### Community 10 - "Community 10"
Cohesion: 0.04
Nodes (2): YouTubePlayerModel, YouTubePlayerView

### Community 11 - "Community 11"
Cohesion: 0.02
Nodes (2): compute(), kernelRempio2()

### Community 12 - "Community 12"
Cohesion: 0.03
Nodes (14): BouncingShape, ModelRoot, Shape, Shapes, ShapesView, ShapeView, Counter, MyModel (+6 more)

### Community 13 - "Community 13"
Cohesion: 0.03
Nodes (6): Domain, removeHandlers(), ModelRealm, ViewRealm, initDEBUG(), View

### Community 14 - "Community 14"
Cohesion: 0.07
Nodes (53): advanceTime(), after(), announceUserJoined(), announceUserLeft(), AUDIT(), cleanStack(), cleanUpCompletedTallies(), clientLeft() (+45 more)

### Community 15 - "Community 15"
Cohesion: 0.05
Nodes (33): addSpinnerStyle(), addToastifyStyle(), addWidgetStyle(), colorsForId(), displayBadgeIfNeeded(), displayQRCodeIfNeeded(), displayStatsIfNeeded(), displayToast() (+25 more)

### Community 16 - "Community 16"
Cohesion: 0.07
Nodes (6): DragDropHandler, SyncedVideoModel, SyncedVideoView, throttle(), TimeBarView, Video2DView

### Community 17 - "Community 17"
Cohesion: 0.09
Nodes (1): Synchronizer

### Community 18 - "Community 18"
Cohesion: 0.08
Nodes (7): BallModel, BallView, ChatModel, ChatView, MyModel, MyView, setUpScene()

### Community 19 - "Community 19"
Cohesion: 0.09
Nodes (4): lerpAngle(), SharedSimulation, SimCar, SimInterface

### Community 20 - "Community 20"
Cohesion: 0.09
Nodes (5): CallbackHandler, Client, discover(), Server, Socket

### Community 21 - "Community 21"
Cohesion: 0.1
Nodes (6): BouncingShape, ModelRoot, Shape, Shapes, ShapesView, ShapeView

### Community 22 - "Community 22"
Cohesion: 0.13
Nodes (2): CroquetWebRTCConnection, getRandomString()

### Community 23 - "Community 23"
Cohesion: 0.14
Nodes (2): CroquetWebRTCConnection, getRandomString()

### Community 24 - "Community 24"
Cohesion: 0.14
Nodes (2): CroquetWebRTCConnection, getRandomString()

### Community 25 - "Community 25"
Cohesion: 0.11
Nodes (6): Computed, effect(), Signal, SignalModel, SignalView, Watchable

### Community 26 - "Community 26"
Cohesion: 0.25
Nodes (14): formatNumber(), formatTimeAgo(), render(), renderAccountsPage(), renderDashboard(), renderKeysPage(), renderMapPage(), renderMetricsPage() (+6 more)

### Community 27 - "Community 27"
Cohesion: 0.17
Nodes (1): M

### Community 28 - "Community 28"
Cohesion: 0.18
Nodes (3): MyModel, MyView, StaticResetCounter

### Community 29 - "Community 29"
Cohesion: 0.14
Nodes (1): M

### Community 30 - "Community 30"
Cohesion: 0.22
Nodes (7): buildPersistentRecord(), buildPersistKey(), buildSessionKey(), lookupPersistentUrl(), storePersistentUrl(), trackSession(), untrackSession()

### Community 31 - "Community 31"
Cohesion: 0.22
Nodes (4): buildUsersMessage(), buildUsersPayload(), createUserBatch(), flushBatch()

### Community 32 - "Community 32"
Cohesion: 0.31
Nodes (8): getCleanUrl(), getJoinUrl(), getSessionNameFromUrl(), getSessionPasswordFromUrl(), getUrlHashParam(), getUrlSearchParam(), setUrlHashParam(), setUrlSearchParam()

### Community 33 - "Community 33"
Cohesion: 0.28
Nodes (2): MyModel, MyView

### Community 34 - "Community 34"
Cohesion: 0.38
Nodes (2): MyModel, MyView

### Community 35 - "Community 35"
Cohesion: 0.7
Nodes (4): corsHeaders(), errorResponse(), handleCors(), jsonResponse()

### Community 36 - "Community 36"
Cohesion: 0.67
Nodes (2): Model, View

### Community 37 - "Community 37"
Cohesion: 0.67
Nodes (0): 

### Community 38 - "Community 38"
Cohesion: 1.0
Nodes (0): 

### Community 39 - "Community 39"
Cohesion: 1.0
Nodes (0): 

### Community 40 - "Community 40"
Cohesion: 1.0
Nodes (0): 

### Community 41 - "Community 41"
Cohesion: 1.0
Nodes (0): 

### Community 42 - "Community 42"
Cohesion: 1.0
Nodes (0): 

### Community 43 - "Community 43"
Cohesion: 1.0
Nodes (0): 

### Community 44 - "Community 44"
Cohesion: 1.0
Nodes (0): 

### Community 45 - "Community 45"
Cohesion: 1.0
Nodes (0): 

### Community 46 - "Community 46"
Cohesion: 1.0
Nodes (0): 

### Community 47 - "Community 47"
Cohesion: 1.0
Nodes (0): 

### Community 48 - "Community 48"
Cohesion: 1.0
Nodes (0): 

### Community 49 - "Community 49"
Cohesion: 1.0
Nodes (0): 

### Community 50 - "Community 50"
Cohesion: 1.0
Nodes (0): 

### Community 51 - "Community 51"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **12 isolated node(s):** `Model`, `View`, `CroquetWarning`, `DataHandle`, `DataHandle` (+7 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 38`** (2 nodes): `colors.ts`, `getUserColor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 39`** (1 nodes): `jest.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 40`** (1 nodes): `vite.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 41`** (1 nodes): `globals.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 42`** (1 nodes): `test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (1 nodes): `fs.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (1 nodes): `rollup.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (1 nodes): `tailwind.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 46`** (1 nodes): `postcss.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 47`** (1 nodes): `templates.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (1 nodes): `css.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 49`** (1 nodes): `webpack.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (1 nodes): `main.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 51`** (1 nodes): `vite-env.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `Model`, `View`, `CroquetWarning` to the rest of the system?**
  _12 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._
- **Should `Community 5` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._