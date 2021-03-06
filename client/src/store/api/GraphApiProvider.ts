import React from "react";
import {
  AbstractGraphApi,
  Graph,
  GraphData,
  TimescaleType,
  timescaleToMs,
} from "../types";
import axios from "axios";
import io from "socket.io-client";

const STREAM_THRESHOLD = 3 * 60 * 1000;

export class GraphApi extends AbstractGraphApi {
  private graphs: Map<(data: GraphData) => void, Graph>;
  private cachedData: Map<(data: GraphData) => void, GraphData>;
  private sensorBindings: Map<
    string,
    { callback: (data: GraphData) => void; graph: Graph; i: number }[]
  >;

  private hostUrl: string;
  private streaming: boolean;
  private to?: Date;
  private scale?: TimescaleType;

  private interval: NodeJS.Timeout | undefined;
  private socket: SocketIOClient.Socket | undefined;

  constructor(
    autoRefresh: number,
    streaming: boolean,
    to?: Date,
    scale?: TimescaleType,
    hostUrl?: string,
    socketUrl?: string
  ) {
    super();

    this.hostUrl = hostUrl ? hostUrl : (process.env.API_URL as string);
    this.streaming = streaming;
    this.to = to;
    this.scale = scale;

    this.graphs = new Map();
    this.cachedData = new Map();
    this.sensorBindings = new Map();

    // Setup polling
    this.interval = setInterval(this.refresh.bind(this), autoRefresh);

    // Setup Streaming
    if (streaming) {
      this.socket = io(
        socketUrl ? socketUrl : (process.env.SOCKET_URL as string),
        {
          transports: ["websocket"],
          autoConnect: false,
        }
      );
      this.socket.on("connect", () => {
        if (!this.socket) return;
        console.log("Connected");

        this.socket.on("measure", (d: Record<string, string>) =>
          this.handleStream(d)
        );

        // Rebind on server restart
        this.socket.on("reconnect", () => {
          this.sensorBindings.forEach((data, topic) => {
            this.socket?.emit("subscribe_sensor", {
              topic,
            });
          });
        });
      });
      this.socket.connect();
    }
  }

  private refresh() {
    this.graphs.forEach((g, c) => {
      // Only poll graphs that should not be streamed
      if (!this.streaming || !this.shouldStream(g)) {
        this.refreshGraph(g, c);
      }
    });
  }

  public refreshGraph(g: Graph, callback: (data: GraphData) => void) {
    // Define timespans
    const scale = this.scale ? this.scale : g.scale ? g.scale : "15m";
    const to = this.to ? this.to : new Date();
    const from = new Date(to.getTime() - timescaleToMs(scale));

    const cache = this.cachedData.get(callback)?.series;
    const data: GraphData = {
      from,
      to,
      scale,
      series: cache
        ? cache
        : g.sensors.map((p) => ({
            id: p.name,
            data: [],
          })),
    };
    this.cachedData.set(callback, data);

    // Make get request for each sensor
    g.sensors.forEach((s, i) => {
      axios
        .get(`${this.hostUrl}/query`, {
          params: {
            group: s.group,
            client: s.client,
            sensor: s.sensor,
            unit: s.unit,
            topic: s.topic,
            start: Math.floor(from.getTime() / 1000),
            stop: Math.floor(to.getTime() / 1000),
          },
        })
        .then((res) => {
          data.series[i] = {
            id: s.name,
            data: res.data.records
              ? res.data.records.map((r: { x: number; y: number }) => ({
                  x: new Date(r.x),
                  y: r.y,
                  key: r.x,
                }))
              : [],
          };

          callback({ ...data, series: [...data.series] });
        });
    });
  }

  public streamGraph(graph: Graph, callback: (data: GraphData) => void) {
    if (!this.streaming || !this.socket || !this.shouldStream(graph)) return;

    graph.sensors.forEach((s, i) => {
      const topic = s.topic
        ? s.topic
        : `sensors/${s.group}/${s.client}/${s.sensor}/${s.unit}`;

      if (this.sensorBindings.has(topic)) {
        this.sensorBindings.get(topic)?.push({ callback, graph, i });
      } else {
        this.sensorBindings.set(topic, [{ callback, graph, i }]);

        // If topic doesn't exist -> not registered for updates
        this.socket?.emit("subscribe_sensor", {
          topic: s.topic,
          group: s.group,
          client: s.client,
          sensor: s.sensor,
          unit: s.unit,
        });
      }
    });
  }

  private handleStream(socketData: Record<string, string>) {
    const binds = this.sensorBindings.get(socketData.topic);
    if (!binds) return;

    binds.forEach((bind) => {
      const cache = this.cachedData.get(bind.callback);
      if (!cache) return;

      // Add new point to tail, remove from beginning
      const newDate = new Date(Math.floor(parseInt(socketData.x) * 1000));
      const data = cache.series[bind.i].data;
      const id = cache.series[bind.i].id;
      data.push({
        x: newDate,
        y: socketData.y,
        key: `${id}-${newDate.toString()}-${new Date().getTime()}`,
      });

      // Calculate new time
      const scale = this.scale
        ? this.scale
        : bind.graph.scale
        ? bind.graph.scale
        : "15m";
      const to = newDate;
      const from = new Date(to.getTime() - timescaleToMs(scale));

      // Remove stale points
      while (data.length && (data[0].x as Date) < from) data.shift();

      bind.callback({ ...cache, series: [...cache.series], from, to });
    });
  }

  public connect(graph: Graph, callback: (data: GraphData) => void): void {
    this.refreshGraph(graph, callback);
    this.graphs.set(callback, graph);
    if (this.streaming) this.streamGraph(graph, callback);
  }
  public disconnect(callback: (data: GraphData) => void): void {
    this.graphs.delete(callback);
  }

  public destroy() {
    if (this.interval) clearInterval(this.interval);
    if (this.socket) this.socket?.disconnect();
  }

  private shouldStream = (g: Graph) =>
    timescaleToMs(g.scale) < STREAM_THRESHOLD ||
    (this.scale ? timescaleToMs(this.scale) < STREAM_THRESHOLD : false);
}

export class StubGraphApi extends AbstractGraphApi {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public connect(): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public disconnect(): void {}
}

const GraphApiContext = React.createContext(
  new StubGraphApi() as AbstractGraphApi
);

export default GraphApiContext;
