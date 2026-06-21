import { createClient } from "@supabase/supabase-js";

type SupabaseConfig = {
  job_id: string;
  execute_at: Date;
  job_type: string;
};

const client = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

export type LogStatus = "completed" | "cancelled" | "failed" | "auto";

async function addJob(_config: SupabaseConfig): Promise<boolean> {
  try {
    const { error } = await client.from("scheduled_jobs").upsert({
      job_id: _config.job_id,
      due_at: _config.execute_at,
      job_type: _config.job_type,
    });
    if (error) {
      console.error(`[scheduler] Error upserting job ${_config.job_id}:`, error);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[scheduler] Exception in addJob for ${_config.job_id}:`, err);
    return false;
  }
}

async function cancelJob(_name: string, _status?: LogStatus): Promise<boolean> {
  try {
    const { error } = await client.from("scheduled_jobs").update({
      status: _status ? _status : "cancelled",
    }).eq("job_id", _name);
    if (error) {
      console.error(`[scheduler] Error updating status for job ${_name}:`, error);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[scheduler] Exception in cancelJob for ${_name}:`, err);
    return false;
  }
}

export async function scheduleCronJob(name: string, executeAt: Date, type: string) {
  const jobConfig: SupabaseConfig = {
    job_id: name,
    execute_at: executeAt,
    job_type: type,
  };
  const res = await addJob(jobConfig);
  return res;
}

export async function cancelScheduledJob(name: string, status?: LogStatus) {
  const res = await cancelJob(name, status);
  return res;
}

export type SupabaseJob = {
  job_id: string;
  due_at: string;
  job_type: string;
  status: string;
};

export async function getActiveScheduledJobs(): Promise<SupabaseJob[]> {
  try {
    const { data, error } = await client
      .from("scheduled_jobs")
      .select("job_id, due_at, job_type, status")
      .in("status", ["pending", "claimed"]);
    if (error) {
      console.error("[scheduler] Error fetching active scheduled jobs:", error);
      return [];
    }
    return data ?? [];
  } catch (err) {
    console.error("[scheduler] Exception fetching active scheduled jobs:", err);
    return [];
  }
}
