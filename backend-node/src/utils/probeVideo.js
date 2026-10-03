const { spawnSync } = require('child_process');
const { getFfprobePath, getFfmpegPath } = require('./ffmpegPath');
function probeVideo(file) {
  const out=spawnSync(getFfprobePath(),['-v','error','-show_entries','format=duration:stream=codec_type,duration,width,height','-of','json',file],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
  if (out.error?.code === 'ENOENT') {
    // Some local distributions bundle ffmpeg only. Inspect and decode the video without installing another binary.
    const decoded=spawnSync(getFfmpegPath(),['-hide_banner','-i',file,'-map','0:v:0','-f','null','-'],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});
    const details=String(decoded.stderr||'');
    const time=details.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const dimensions=details.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
    if(decoded.error||decoded.status!==0||!time||!dimensions)throw new Error('视频缺少有效视频流，或 FFmpeg 解码校验失败');
    return {duration_ms:Math.round((Number(time[1])*3600+Number(time[2])*60+Number(time[3]))*1000),has_audio:/Stream[^\n]*Audio:/.test(details),width:Number(dimensions[1]),height:Number(dimensions[2])};
  }
  if(out.error||out.status!==0) throw new Error('视频媒体校验失败：'+(out.error?.message||out.stderr||'ffprobe 不可用').slice(0,200));
  const media=JSON.parse(out.stdout),stream=(media.streams||[]).find(s=>s.codec_type==='video');
  // Keep a longer audio tail when merging; never truncate dialogue to the video stream duration.
  const seconds=Math.max(...[media.format?.duration,...(media.streams||[]).map(s=>s.duration)].map(Number).filter(Number.isFinite));
  if(!stream||!Number.isFinite(seconds)||seconds<=0) throw new Error('下载内容缺少有效视频流或有效时长');
  return {duration_ms:Math.round(seconds*1000),has_audio:(media.streams||[]).some(s=>s.codec_type==='audio'),width:stream.width,height:stream.height};
}
module.exports={probeVideo};
