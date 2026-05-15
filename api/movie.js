
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

  const id = req.query.id

  let movies = await loadMovies()

  const index = movies.findIndex(
    m => m.id === id
  )

  if(index === -1){

    return res.status(404).json({
      error:'Movie not found'
    })
  }

  if(req.method === 'PUT'){

    movies[index] = {
      ...movies[index],
      ...req.body
    }

    await saveMovies(movies)

    return res.status(200).json(
      movies[index]
    )
  }

  if(req.method === 'DELETE'){

    movies.splice(index, 1)

    await saveMovies(movies)

    return res.status(200).json({
      success:true
    })
  }
}
