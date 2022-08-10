import * as fs from 'fs'

function NodeFSStorageAdapter(directory = ".amrg") {
  function fileName(docId) {
    return `${directory}/${docId}.amrg`;
  }

  return {
    load: (docId) => {
      return new Promise((resolve, reject) => {
        fs.readFile(fileName(docId), (err, data) => {
          if (err) resolve(null); else resolve(data)
        });
      });
    },

    save: (docId, binary) => {
      fs.writeFile(fileName(docId), binary, err => {
        // TODO: race condition if a load happens before the save is complete.
        // use an in-memory cache while save is in progress
        if (err) throw err;
      });
    },

    remove: (docId) => {
      fs.rm(fileName(docId), err => {
        if (err) throw err;
      });
    }
  }
}

export default NodeFSStorageAdapter
