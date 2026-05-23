"use client";

import { useState, useEffect, useCallback } from "react";

export interface KpiData {
  totalRequests: number;
  successRate: number;
  avgResponseTime: number;
  activeAgents: number;
}

export interface TrendPoint {
  time: string;
  requests: number;
  errors: number;
}

export interface ModuleUsage {
  name: string;
  count: number;
}

export interface ToolDistribution {
  name: string;
  value: number;
}

export interface DashboardData {
  kpi: KpiData;
  trends: TrendPoint[];
  modules: ModuleUsage[];
  tools: ToolDistribution[];
}

function generateTimeLabel(): string {
  const now = new Date();
  return `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
}

function generateInitialTrends(): TrendPoint[] {
  const trends: TrendPoint[] = [];
  const now = new Date();
  for (let i = 20; i >= 0; i--) {
    const time = new Date(now.getTime() - i * 3000);
    const label = `${time.getHours().toString().padStart(2, "0")}:${time.getMinutes().toString().padStart(2, "0")}:${time.getSeconds().toString().padStart(2, "0")}`;
    trends.push({
      time: label,
      requests: Math.floor(Math.random() * 50) + 30,
      errors: Math.floor(Math.random() * 5),
    });
  }
  return trends;
}

const INITIAL_DATA: DashboardData = {
  kpi: {
    totalRequests: 12847,
    successRate: 98.6,
    avgResponseTime: 245,
    activeAgents: 12,
  },
  trends: generateInitialTrends(),
  modules: [
    { name: "Agent Loop", count: 3420 },
    { name: "Tool Dispatch", count: 2890 },
    { name: "Task System", count: 2150 },
    { name: "Memory Mgmt", count: 1870 },
    { name: "Background", count: 1560 },
    { name: "Teams", count: 980 },
  ],
  tools: [
    { name: "read_file", value: 35 },
    { name: "edit_file", value: 25 },
    { name: "bash", value: 20 },
    { name: "send_message", value: 15 },
    { name: "other", value: 5 },
  ],
};

export function useRealtimeData(updateInterval = 3000) {
  const [data, setData] = useState<DashboardData>(INITIAL_DATA);

  const updateData = useCallback(() => {
    setData((prev) => {
      const newTrends = [...prev.trends.slice(1)];
      newTrends.push({
        time: generateTimeLabel(),
        requests: Math.floor(Math.random() * 50) + 30,
        errors: Math.floor(Math.random() * 5),
      });

      return {
        kpi: {
          totalRequests: prev.kpi.totalRequests + Math.floor(Math.random() * 10) + 1,
          successRate: Math.min(99.9, prev.kpi.successRate + (Math.random() - 0.5) * 0.2),
          avgResponseTime: Math.max(100, prev.kpi.avgResponseTime + (Math.random() - 0.5) * 10),
          activeAgents: Math.max(5, Math.min(20, prev.kpi.activeAgents + Math.floor((Math.random() - 0.5) * 2))),
        },
        trends: newTrends,
        modules: prev.modules.map((m) => ({
          ...m,
          count: m.count + Math.floor(Math.random() * 5),
        })),
        tools: prev.tools,
      };
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(updateData, updateInterval);
    return () => clearInterval(interval);
  }, [updateInterval, updateData]);

  return data;
}
