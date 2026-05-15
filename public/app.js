
let movies = []

const UNSORTED_TITLES = [
'SOUTH PARK',
'LAPUTA',
'KING OF KINGS',
'JAWS',
'TRON',
'TRON LEGACY'
]

async function loadMovies(){
  const res = await fetch('/api/movies')
  const data = await res.json()

  movies = data.movies || []

  render()
}

function render(){
  const container = document.getElementById('movies')
  const search = document.getElementById('search').value.toLowerCase()

  const filtered = movies.filter(m =>
    m.title.toLowerCase().includes(search)
  )

  container.innerHTML = ''

  let total = 0

  filtered.forEach(movie => {

    total += Number(movie.price || 0)

    const div = document.createElement('div')
    div.className = 'movie'

    div.innerHTML = `
      <h3>${movie.title}</h3>

      <div>Section: ${movie.section}</div>
      <div>Format: ${movie.format}</div>
      <div>Price: ${movie.price || 0} kr</div>

      <label>
        Seen
        <input type="checkbox" ${movie.seen ? 'checked' : ''}
          onchange="toggleSeen('${movie.id}', this.checked)">
      </label>

      <button onclick="deleteMovie('${movie.id}')">Delete</button>
    `

    container.appendChild(div)
  })

  document.getElementById('collectionValue').innerText =
    total.toLocaleString() + ' kr'
}

async function addMovie(){

  const movie = {
    id: crypto.randomUUID(),
    title: document.getElementById('title').value,
    section: document.getElementById('section').value,
    format: document.getElementById('format').value,
    price: Number(document.getElementById('price').value || 0),
    seen:false
  }

  await fetch('/api/movies', {
    method:'POST',
    headers:{
      'Content-Type':'application/json'
    },
    body:JSON.stringify(movie)
  })

  loadMovies()
}

async function toggleSeen(id, seen){

  await fetch('/api/movie?id=' + id, {
    method:'PUT',
    headers:{
      'Content-Type':'application/json'
    },
    body:JSON.stringify({ seen })
  })

  loadMovies()
}

async function deleteMovie(id){

  await fetch('/api/movie?id=' + id, {
    method:'DELETE'
  })

  loadMovies()
}

document.getElementById('search')
  .addEventListener('input', render)

loadMovies()
