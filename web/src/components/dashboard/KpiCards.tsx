"use client";

import { motion } from "framer-motion";
import { Activity, CheckCircle, Clock, Users } from "lucide-react";
import { KpiData } from "./useRealtimeData";

interface KpiCardsProps {
  kpi: KpiData;
}

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.4 },
  }),
};

export function KpiCards({ kpi }: KpiCardsProps) {
  const cards = [
    {
      title: "Total Requests",
      value: kpi.totalRequests.toLocaleString(),
      icon: Activity,
      color: "text-blue-500",
      bgColor: "bg-blue-50 dark:bg-blue-900/20",
    },
    {
      title: "Success Rate",
      value: `${kpi.successRate.toFixed(1)}%`,
      icon: CheckCircle,
      color: "text-emerald-500",
      bgColor: "bg-emerald-50 dark:bg-emerald-900/20",
    },
    {
      title: "Avg Response Time",
      value: `${kpi.avgResponseTime.toFixed(0)}ms`,
      icon: Clock,
      color: "text-amber-500",
      bgColor: "bg-amber-50 dark:bg-amber-900/20",
    },
    {
      title: "Active Agents",
      value: kpi.activeAgents.toString(),
      icon: Users,
      color: "text-purple-500",
      bgColor: "bg-purple-50 dark:bg-purple-900/20",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card, i) => (
        <motion.div
          key={card.title}
          custom={i}
          variants={cardVariants}
          initial="hidden"
          animate="visible"
          className={`rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800 ${card.bgColor}`}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {card.title}
              </p>
              <p className="mt-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                {card.value}
              </p>
            </div>
            <div className={`rounded-lg p-2.5 ${card.bgColor}`}>
              <card.icon className={`h-6 w-6 ${card.color}`} />
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
