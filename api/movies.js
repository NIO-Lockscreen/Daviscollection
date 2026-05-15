
import { put, list, del } from '@vercel/blob'

const BLOB_NAME = 'movies.json'

async function loadMovies(){

  const blobs = await list()

  const existing = blobs.blobs.find(
    b => b.pathname === BLOB_NAME
  )

  if(!existing){
    return []
  }

  const response = await fetch(existing.url)

  return await response.json()
}

async function saveMovies(movies){

  await del(BLOB_NAME).catch(() => {})

  await put(
    BLOB_NAME,
    JSON.stringify(movies, null, 2),
    {
      access:'public',
      addRandomSuffix:false
    }
  )
}

export default async function handler(req, res){

  let movies = await loadMovies()

  if(req.method === 'GET'){

    return res.status(200).json({
      movies
    })
  }

  if(req.method === 'POST'){

    movies.push(req.body)

    await saveMovies(movies)

    return res.status(200).json({
      success:true
    })
  }
}
