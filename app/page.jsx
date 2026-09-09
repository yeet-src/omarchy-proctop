import { Index, createSignal, onCleanup } from "yeetkit";

/* The whole plugin is one page. Two elements in it are special: <bar>
 * is what sits in the bar, and <panel> is what opens under it. Both
 * run here, in the isolate, next to the data they show.
 *
 * Samples arrive by subscription, not by polling: the daemon reads the
 * kernel at the interval asked for and pushes each sample, so there is
 * no timer here and nothing re-queries on a tick.
 *
 * The design is one character grid. The shell's font is monospace, so
 * every aligned line — chart header, braille graph, table row — is
 * padded to the same number of columns, which makes their edges line up
 * and fills the panel exactly. That column count is not guessed: the
 * panel measures it from the real font metrics and reports it as `cols`,
 * because it depends on the user's font size.
 *
 * No colour is named here: `heat` takes one from the theme (muted →
 * accent → urgent), so the panel follows whatever theme is running. */

const HZ = 1000; /* sample interval while the panel is open, ms */
const IDLE = 4000; /* …and while it is closed: the bar only needs the count */

const ROWS = 10; /* processes listed */
const HOT = 0.25; /* a process holding this much of RAM reads as fully hot */
const HIST = 400; /* samples kept — more than the widest panel can show */

/* A braille cell is a 2x4 dot matrix, so one line of N characters holds
 * 2N samples and GH lines stack into GH*4 vertical levels — how btop
 * fits a dense graph into a few character rows. */
const GH = 4;
const LEVELS = GH * 4;
const LEFT = [0x01, 0x02, 0x04, 0x40]; /* dots 1,2,3,7 — top to bottom */
const RIGHT = [0x08, 0x10, 0x20, 0x80]; /* dots 4,5,6,8 */

const braille = (samples, width, lo, hi) => {
  const lines = [];
  for (let r = 0; r < GH; r++) {
    let line = "";
    for (let x = 0; x < width; x++) {
      let bits = 0;
      for (let col = 0; col < 2; col++) {
        const value = samples[x * 2 + col];
        if (value === undefined) continue;
        /* Floored at one level so a near-zero sample still draws the
         * baseline: without it the CPU chart reads as empty between
         * spikes while memory, sitting high, shows a solid floor. */
        const fill = Math.max(1, Math.round(((value - lo) / (hi - lo)) * LEVELS));
        const dots = col === 0 ? LEFT : RIGHT;
        for (let k = 0; k < 4; k++) {
          /* depth counts levels down from the top of the graph; a level
           * lights once the column has filled up to it. */
          const depth = r * 4 + k;
          if (LEVELS - depth <= fill) bits |= dots[k];
        }
      }
      line += String.fromCharCode(0x2800 + bits);
    }
    lines.push(line);
  }
  return lines;
};

/* One braille row: 2 samples per character, 4 levels tall. Bars rise
 * from the baseline rather than tracing a line, which is what gives the
 * per-process columns their level-meter look. */
const SPARK_W = 10;
const SPARK_SAMPLES = SPARK_W * 2;

const sparkline = (samples, width, lo, hi, curved) => {
  /* Right-aligned: the newest sample belongs in the last cell, so a
   * series with less history than the chart is wide fills from the right
   * edge leftwards rather than starting at the left and leaving the
   * newest reading in the middle. */
  const slots = width * 2;
  const window = samples.length >= slots
    ? samples.slice(-slots)
    : Array(slots - samples.length).fill(undefined).concat(samples);

  let line = "";
  for (let x = 0; x < width; x++) {
    let bits = 0;
    for (let col = 0; col < 2; col++) {
      const value = window[x * 2 + col];
      if (value === undefined) continue;
      const ratio = Math.max(0, (value - lo) / (hi - lo));
      const fill = Math.max(1, Math.min(4, Math.round((curved ? Math.sqrt(ratio) : ratio) * 4)));
      const dots = col === 0 ? LEFT : RIGHT;
      for (let k = 0; k < 4; k++) if (4 - k <= fill) bits |= dots[k];
    }
    line += String.fromCharCode(0x2800 + bits);
  }
  return line;
};

/* The window scrolls: a new sample enters at the right and the oldest
 * falls off the left. The first sample fills the buffer, so the chart is
 * full width from the first frame and scrolls from then on rather than
 * creeping in from the right edge for two minutes. */
const push = (past, value) =>
  (past.length ? [...past, value] : Array(HIST).fill(value)).slice(-HIST);

/* Bars never dim: the scale starts at the theme accent and only
 * climbs toward urgent, so height carries the value. */
const lift = (ratio) => 0.5 + 0.5 * Math.max(0, Math.min(1, ratio));

/* Top row hottest, bottom row coolest — btop's vertical gradient — but
 * floored well above 0 so the lowest row never lands on `muted` and
 * fades out. */
const rowHeat = (r) => 1 - 0.55 * (r / (GH - 1));

/* Both sparklines, RSS and the live CPU figure are fixed-width; the
 * name takes what is left, so the table fills the reported width.
 * name+1 + (SPARK_W+1)*2 + RSS_W + NOW_W = cols */
const RSS_W = 9;
const NOW_W = 7; /* the live CPU figure and the gap after it */
const NOW_FIG = 4; /* "100%" — right-aligned, so the figure sits hard against
                    * the CPU chart it belongs to and the slack falls on the
                    * RAM side instead of between the two. */
const columns = (cols) => ({
  name: Math.max(8, cols - (SPARK_W + 1) * 2 - RSS_W - NOW_W - 1),
});

const BAR_W = 4; /* braille cells per sparkline in the bar: 8 samples */

const gib = (n) => (n / 1073741824).toFixed(1);
const size = (n) => (n >= 1073741824 ? `${gib(n)} GiB` : `${Math.round(n / 1048576)} MiB`);
const pct = (share) => `${Math.round(share * 100)}%`;
const filled = (share, cells) => Math.max(0, Math.min(cells, Math.round(share * cells)));
const clip = (name, width) =>
  (name.length > width ? `${name.slice(0, width - 1)}…` : name).padEnd(width);

const busy = (t) =>
  t.user_ms + t.nice_ms + t.system_ms + (t.irq_ms || 0) + (t.softirq_ms || 0) + (t.steal_ms || 0);
const spent = (t) => busy(t) + t.idle_ms + (t.iowait_ms || 0);

export default function Page() {
  const [count, setCount] = createSignal(0);
  const [threads, setThreads] = createSignal(0);
  const [running, setRunning] = createSignal(0);
  const [rows, setRows] = createSignal([]);
  const [byCpu, setByCpu] = createSignal(false);
  const [mem, setMem] = createSignal({ total: 0, available: 0 });
  const [memPast, setMemPast] = createSignal([]);
  const [cpu, setCpu] = createSignal(0);
  const [cpuPast, setCpuPast] = createSignal([]);
  const [load, setLoad] = createSignal(0);
  const [load5, setLoad5] = createSignal(0);
  const [load15, setLoad15] = createSignal(0);
  const [cores, setCores] = createSignal(0);
  const [open, setOpen] = createSignal(false);
  const [cols, setCols] = createSignal(48);
  /* Real samples seen, so the window label does not claim history that
   * is only the first reading held flat. */
  const [ticks, setTicks] = createSignal(0);

  /* One subscription per root field: a subscription carrying several of
   * them delivers only the first, so they cannot be combined. Each
   * ticket arrives as a promise, and `unsubscribe` wants the resolved
   * string, so they are collected as they settle. */
  const tickets = [];
  let disposed = false;

  const live = async (field, apply) => {
    const ticket = await yeet.graph.subscribe(`subscription { ${field} }`, (sample) =>
      apply(sample.data ?? sample),
    );
    if (disposed) yeet.graph.unsubscribe(ticket);
    else tickets.push(ticket);
  };

  /* Per-process CPU: schedstat.sum_exec_runtime is cumulative
   * nanoseconds on-CPU, so a process's share of one core is its change
   * over wall time. Wall time is measured, not assumed, because the
   * interval changes when the panel opens. */
  let seen = null;
  let seenAt = 0;
  /* Per-process history, keyed by pid and rebuilt each tick so a
   * process that exits takes its series with it. Kept outside a signal
   * and snapshotted into the rows, since a mutated Map is not
   * reactive. */
  let series = new Map();

  const onProcs = (data) => {
    setCount(data.procs.length);

    const now = Date.now();
    const runtime = new Map();
    for (const proc of data.procs) {
      if (proc.schedstat) runtime.set(proc.pid, proc.schedstat.sum_exec_runtime);
    }
    const elapsed = seen ? (now - seenAt) * 1e6 : 0; /* ms → ns */
    const shares = new Map();
    if (elapsed > 0) {
      for (const [pid, ns] of runtime) {
        const before = seen.get(pid);
        if (before !== undefined) shares.set(pid, Math.max(0, (ns - before) / elapsed));
      }
    }
    seen = runtime;
    seenAt = now;

    /* A process can go away between the enumeration and its stat read,
     * and the graph reports that as a null stat rather than dropping the
     * row — so the count is every process, but only the measured ones
     * can be ranked. */
    const measured = data.procs.filter((proc) => proc.stat);
    setThreads(measured.reduce((n, proc) => n + proc.stat.num_threads, 0));

    const next = new Map();
    for (const proc of measured) {
      const prior = series.get(proc.pid) || { cpu: [], mem: [] };
      next.set(proc.pid, {
        cpu: [...prior.cpu, shares.get(proc.pid) ?? 0].slice(-SPARK_SAMPLES),
        mem: [...prior.mem, proc.stat.rss_bytes].slice(-SPARK_SAMPLES),
      });
    }
    series = next;

    /* Every row is annotated and kept; which ones show, and in what
     * order, is decided when rendering — so flipping the sort re-orders
     * at once instead of waiting for the next sample. */
    setRows(
      measured.map((proc) => {
        const past = series.get(proc.pid);
        return { ...proc, cpu: shares.get(proc.pid) ?? 0, cpuPast: past.cpu, memPast: past.mem };
      }),
    );
  };

  /* `procs` is the heavy field — every process with its stat, every
   * tick — and the table is its only consumer, so it is held apart from
   * the others and re-subscribed at a slower rate while the panel is
   * shut, where all the bar needs from it is the count. */
  let procs = null;
  const watchProcs = async (interval) => {
    if (procs) {
      yeet.graph.unsubscribe(procs);
      procs = null;
    }
    const ticket = await yeet.graph.subscribe(
      `subscription { procs(interval_ms: ${interval}) { pid schedstat { sum_exec_runtime } stat { comm rss_bytes num_threads } } }`,
      (sample) => onProcs(sample.data ?? sample),
    );
    if (disposed) yeet.graph.unsubscribe(ticket);
    else procs = ticket;
  };

  watchProcs(IDLE);

  live(`meminfo(interval_ms: ${HZ}) { mem_total mem_available }`, (data) => {
    const all = data.meminfo.mem_total;
    const free = data.meminfo.mem_available;
    setMem({ total: all, available: free });
    setMemPast((past) => push(past, all ? (all - free) / all : 0));
    setTicks((n) => n + 1);
  });

  /* CPU is a counter, so utilisation is the change between samples:
   * everything but idle and iowait, over the whole tick. */
  let previous = null;
  live(
    `kernel_stats(interval_ms: ${HZ}) { total { user_ms nice_ms system_ms idle_ms iowait_ms irq_ms softirq_ms steal_ms } procs_running }`,
    (data) => {
      const now = data.kernel_stats.total;
      setRunning(data.kernel_stats.procs_running || 0);
      if (previous) {
        const window = spent(now) - spent(previous);
        const share = window > 0 ? (busy(now) - busy(previous)) / window : 0;
        const clamped = Math.max(0, Math.min(1, share));
        setCpu(clamped);
        setCpuPast((past) => push(past, clamped));
      }
      previous = now;
    },
  );

  live(`load_average(interval_ms: ${HZ}) { one five fifteen }`, (data) => {
    setLoad(data.load_average.one);
    setLoad5(data.load_average.five);
    setLoad15(data.load_average.fifteen);
  });

  /* Core count does not change, so it is asked for once. */
  yeet.graph.query(`{ cpu { num_cores } }`).then(({ data }) => setCores(data.cpu.num_cores));

  onCleanup(() => {
    disposed = true;
    for (const ticket of tickets) yeet.graph.unsubscribe(ticket);
    tickets.length = 0;
    if (procs) yeet.graph.unsubscribe(procs);
    procs = null;
  });

  const used = () => mem().total - mem().available;
  const usedShare = () => (mem().total ? used() / mem().total : 0);
  const samples = () => cols() * 2;
  const window = () => Math.min(ticks(), samples());

  /* Memory sits in a narrow band, so a 0..peak axis draws it as a solid
   * block. Framing it on its own min..max — with a floor on the span so
   * sampling noise cannot fill the frame — is what makes the movement
   * legible, and the axis is labelled with that band. CPU keeps an
   * absolute 0-100% axis: it is spiky enough to stay interesting, and
   * there the height means something on its own. */
  const memRange = () => {
    const past = memPast().slice(-samples());
    if (!past.length) return { lo: 0, hi: 0.05 };
    const lo = Math.min.apply(null, past);
    const hi = Math.max.apply(null, past);
    const span = Math.max(0.03, (hi - lo) * 1.3);
    const mid = (lo + hi) / 2;
    return { lo: Math.max(0, mid - span / 2), hi: Math.min(1, mid + span / 2) };
  };

  const cpuGraph = () => braille(cpuPast().slice(-samples()), cols(), 0, 1);
  const memGraph = () => {
    const band = memRange();
    return braille(memPast().slice(-samples()), cols(), band.lo, band.hi);
  };

  const top = () => {
    const all = [...rows()];
    all.sort(byCpu() ? (a, b) => b.cpu - a.cpu : (a, b) => b.stat.rss_bytes - a.stat.rss_bytes);
    return all.slice(0, ROWS);
  };

  /* Sorted by CPU the largest process is no longer first, so the RAM
   * bars scale against the largest of the rows on show. */
  const peak = () => {
    let max = 1;
    for (const proc of top()) if (proc.stat.rss_bytes > max) max = proc.stat.rss_bytes;
    return max;
  };

  /* Both sparkline columns are scaled across the whole table rather than
   * per row: a busier or larger process then draws taller bars, which is
   * the comparison worth seeing. */
  const cpuTop = () => {
    let max = 0.05;
    for (const proc of top()) for (const v of proc.cpuPast) if (v > max) max = v;
    return max;
  };
  const share = (rss) => rss / (mem().total || 1);

  /* The bar gets the same treatment as the panel, just shorter: CPU on
   * an absolute axis, memory framed on its own band so it moves at all. */
  const barCpu = () => sparkline(cpuPast().slice(-BAR_W * 2), BAR_W, 0, 1, false);
  const barMem = () => {
    const band = memRange();
    return sparkline(memPast().slice(-BAR_W * 2), BAR_W, band.lo, band.hi, false);
  };

  /* left, then a label filling the middle, then a right-aligned figure —
   * exactly `cols` characters wide. */
  const middle = () => Math.max(1, cols() - 5 - 9);

  return (
    <>
      {/* One colour for the whole label — the host draws a bar item as a
          single Text, so the braille and the count cannot differ. It
          tracks whichever of the two pressures is higher. */}
      <bar
        heat={lift(Math.max(cpu(), usedShare()))}
        tooltipText={`CPU ${pct(cpu())} · ${size(used())} of ${size(mem().total)} · ${count()} processes`}
      >
        {`${barCpu()} ${pct(cpu())} ${barMem()} ${pct(usedShare())} `
          + `${load().toFixed(2)} / ${load5().toFixed(2)} / ${load15().toFixed(2)}`}
      </bar>

      <panel
        contentWidth={420}
        gap={6}
        onCols={(e) => setCols(e.cols)}
        onOpen={() => {
          setOpen(true);
          watchProcs(HZ);
        }}
        onClose={() => {
          setOpen(false);
          watchProcs(IDLE);
        }}
      >
        <column gap={2}>
          <row gap={0}>
            <text bold heat={cpu()}>{pct(cpu()).padEnd(5)}</text>
            <text>{`CPU · ${window()}s`.padEnd(middle())}</text>
            <text>{`${cores()} cores`.padStart(9)}</text>
          </row>
          <column gap={0}>
            <Index each={cpuGraph()}>{(line, r) => <text heat={rowHeat(r)}>{line()}</text>}</Index>
          </column>
        </column>

        <separator />

        <column gap={2}>
          <row gap={0}>
            <text bold heat={usedShare()}>{pct(usedShare()).padEnd(5)}</text>
            <text>{`MEMORY · ${window()}s`.padEnd(middle())}</text>
            <text>{`${pct(memRange().lo)}–${pct(memRange().hi)}`.padStart(9)}</text>
          </row>
          <column gap={0}>
            <Index each={memGraph()}>{(line, r) => <text heat={rowHeat(r)}>{line()}</text>}</Index>
          </column>
          <text size="bodySmall">
            {size(used())} used · {size(mem().available)} available · {size(mem().total)} total
          </text>
        </column>

        <separator />

        <column gap={2}>
          {/* The heading is the control: unselected and unbordered is how
              the host draws a plain clickable label, so it reads as text
              until hovered. No separate affordance to place. */}
          <button
            horizontalPadding={0}
            verticalPadding={0}
            tooltipText={byCpu() ? "Sort by memory" : "Sort by CPU"}
            onClick={() => setByCpu(!byCpu())}
          >
            {`Top by ${byCpu() ? "CPU" : "memory"}`}
          </button>

          <row gap={0}>
            <text bold>{"PROCESS".padEnd(columns(cols()).name + 1)}</text>
            <text bold>{"CPU".padStart(SPARK_W) + " "}</text>
            <text bold>{"NOW".padStart(NOW_FIG) + " ".repeat(NOW_W - NOW_FIG)}</text>
            <text bold>{"RAM".padStart(SPARK_W) + " "}</text>
            <text bold>{"RSS".padStart(RSS_W)}</text>
          </row>

          {/* <Index> keys by position and hands down an accessor, so a
              fresh sample patches the cells that moved rather than
              rebuilding every row. */}
          <Index each={top()}>
            {(proc, i) => (
              <row gap={0}>
                <text bold={i === 0}>
                  {clip(proc().stat.comm, columns(cols()).name) + " "}
                </text>
                <text heat={lift(proc().cpu / cpuTop())}>
                  {sparkline(proc().cpuPast, SPARK_W, 0, cpuTop(), false) + " "}
                </text>
                <text heat={lift(proc().cpu / cpuTop())}>
                  {pct(proc().cpu).padStart(NOW_FIG) + " ".repeat(NOW_W - NOW_FIG)}
                </text>
                <text heat={lift(share(proc().stat.rss_bytes) / HOT)}>
                  {sparkline(proc().memPast, SPARK_W, 0, peak() || 1, true) + " "}
                </text>
                <text>{size(proc().stat.rss_bytes).padStart(RSS_W)}</text>
              </row>
            )}
          </Index>

          <separator />

          <row gap={0}>
            <text size="bodySmall">{`${count()} procs · ${running()} running · ${threads()} threads · load `}</text>
            {/* Plain foreground rather than a gradient: on a theme whose
                accent sits near the background, any point on the ramp
                below urgent reads as dimmed. It goes urgent only once
                load passes the core count, which is the case worth
                colouring. */}
            <text size="bodySmall" tone={load() > (cores() || 1) ? "urgent" : "fg"}>
              {load().toFixed(2)}
            </text>
            <text size="bodySmall">{open() ? " · live 1 Hz" : ""}</text>
          </row>
        </column>
      </panel>
    </>
  );
}
