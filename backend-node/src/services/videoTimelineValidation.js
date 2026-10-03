function validateTimeline(text, totalSec) {
  const hits = [...String(text || '').matchAll(/^\s*分镜(\d+)\s*[:：]\s*(\d+(?:\.\d+)?)\s*秒\s*[:：]/gm)];
  if (!hits.length) {
    const spans = [...String(text || '').matchAll(/[\[【]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[|｜]/g)];
    if (!spans.length) return { ok: true, recognized: false };
    let end = 0;
    for (const span of spans) {
      const start = Math.round(Number(span[1])*1000), next = Math.round(Number(span[2])*1000);
      if (Math.abs(start-end)>10 || next<=start) return { ok:false, message:'视频 Skill 时间轴存在重叠、空隙或倒序，请重新编译' };
      end = next;
    }
    return Math.abs(end-Math.round(totalSec*1000))<=10 ? {ok:true,recognized:true,total_ms:end} : {ok:false,message:`视频 Skill 时间轴结束于 ${end/1000} 秒，与提交 ${totalSec} 秒不一致，请重新编译`};
  }
  let total = 0;
  for (let i=0;i<hits.length;i++) {
    if (Number(hits[i][1]) !== i+1 || Number(hits[i][2]) <= 0) return { ok:false, message:'子镜头编号必须连续且时长为正，不能跳号或重复' };
    total += Math.round(Number(hits[i][2])*1000);
  }
  if (Math.abs(total-Math.round(totalSec*1000)) > 10) return { ok:false, message:`子镜头合计 ${total/1000} 秒，与本段 ${totalSec} 秒不一致。请重新编译提示词，不自动按比例压缩台词或动作` };
  return { ok:true, recognized:true, total_ms:total };
}
function assertTimeline(text, seconds) { const result=validateTimeline(text,seconds); if(!result.ok) { const e=new Error(result.message);e.status=409;throw e; } return text; }
module.exports = { validateTimeline, assertTimeline };
