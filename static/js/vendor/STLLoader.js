// Minimal STLLoader (ASCII + Binary) for Three.js subset
THREE.STLLoader=function(){};
THREE.STLLoader.prototype={
  load:function(url,onLoad){
    fetch(url).then(r=>r.arrayBuffer()).then(buf=>{
      onLoad(this.parse(buf));
    });
  },
  parse:function(buffer){
    function isBinary(buf){
      const str=String.fromCharCode.apply(null,new Uint8Array(buf.slice(0,80)));
      return !str.match(/solid/i);
    }
    const geo=new THREE.Geometry();
    const dv=new DataView(buffer);
    let offset=0;
    if(isBinary(buffer)){
      offset=80;
      const count=dv.getUint32(offset,true); offset+=4;
      for(let i=0;i<count;i++){
        offset+=12; // normal skip
        const a=new THREE.Vector3(
          dv.getFloat32(offset,true), dv.getFloat32(offset+4,true), dv.getFloat32(offset+8,true)
        ); offset+=12;
        const b=new THREE.Vector3(
          dv.getFloat32(offset,true), dv.getFloat32(offset+4,true), dv.getFloat32(offset+8,true)
        ); offset+=12;
        const c=new THREE.Vector3(
          dv.getFloat32(offset,true), dv.getFloat32(offset+4,true), dv.getFloat32(offset+8,true)
        ); offset+=12;
        offset+=2; // attr
        const vIdx=geo.vertices.length;
        geo.vertices.push(a,b,c);
        geo.faces.push(new THREE.Face3(vIdx,vIdx+1,vIdx+2));
      }
    } else {
      const text=new TextDecoder().decode(buffer);
      const lines=text.split("\n");
      let verts=[];
      for(let l of lines){
        l=l.trim();
        if(l.startsWith("vertex")){
          const p=l.split(/\s+/);
          verts.push(new THREE.Vector3(+p[1],+p[2],+p[3]));
          if(verts.length===3){
            const vIdx=geo.vertices.length;
            geo.vertices.push(verts[0],verts[1],verts[2]);
            geo.faces.push(new THREE.Face3(vIdx,vIdx+1,vIdx+2));
            verts=[];
          }
        }
      }
    }
    return geo;
  }
};
